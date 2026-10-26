#!/usr/bin/env bash
# Idempotent store bootstrap. Runs as an initContainer before Apache starts, on every pod start:
#  - seeds/upgrades WordPress core in the persistent volume
#  - installs WordPress + WooCommerce + Storefront on first boot
#  - re-applies config that comes from Helm values (URL, timezone, ...) on every boot
#  - (re)registers the WooCommerce REST API key used by the MCP server, from a Kubernetes Secret
set -euo pipefail

: "${SITE_URL:?}" "${WORDPRESS_DB_HOST:?}" "${WORDPRESS_DB_USER:?}" "${WORDPRESS_DB_PASSWORD:?}" "${WORDPRESS_DB_NAME:?}"
: "${WP_ADMIN_USER:?}" "${WP_ADMIN_PASSWORD:?}" "${WP_ADMIN_EMAIL:?}"
: "${WC_CONSUMER_KEY:?}" "${WC_CONSUMER_SECRET:?}"
STORE_TITLE="${STORE_TITLE:-Urumi Store}"
STORE_TIMEZONE="${STORE_TIMEZONE:-UTC}"
STORE_CURRENCY="${STORE_CURRENCY:-USD}"
SEED_PRODUCTS="${SEED_PRODUCTS:-true}"

log() { echo "[store-init] $*"; }
# Some WooCommerce options are guarded by filters; a failed write must not block boot.
opt() { wp option update "$@" --quiet || log "warn: could not set option $1"; }
cd /var/www/html

# ---- 1. WordPress core files in the volume -------------------------------------------------
img_ver=$(php -r 'include "/usr/src/wordpress/wp-includes/version.php"; echo $wp_version;')
if [ ! -e wp-includes/version.php ]; then
  log "seeding WordPress ${img_ver} into volume"
  tar -C /usr/src/wordpress -cf - . | tar --no-overwrite-dir -xf -
else
  cur_ver=$(php -r 'include "wp-includes/version.php"; echo $wp_version;')
  if [ "$cur_ver" != "$img_ver" ]; then
    log "upgrading WordPress core files ${cur_ver} -> ${img_ver}"
    tar -C /usr/src/wordpress --exclude=./wp-content -cf - . | tar --no-overwrite-dir -xf -
  fi
fi

if [ ! -f wp-config.php ]; then
  log "creating wp-config.php (reads DB settings from env)"
  cp /usr/src/wordpress/wp-config-docker.php wp-config.php
  php -r '$f="wp-config.php"; $c=file_get_contents($f);
    $c=preg_replace_callback("/put your unique phrase here/", fn() => bin2hex(random_bytes(32)), $c);
    file_put_contents($f, $c);'
fi

if [ ! -f .htaccess ]; then
  cat > .htaccess <<'HTACCESS'
DirectorySlash Off
# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule ^wp-admin$ http://%{HTTP_HOST}/wp-admin/ [R=301,L]
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
HTACCESS
fi
if [ -f .htaccess ] && ! grep -q "DirectorySlash Off" .htaccess; then
  sed -i '1i DirectorySlash Off\nRewriteRule ^wp-admin$ http://%{HTTP_HOST}/wp-admin/ [R=301,L]' .htaccess || true
fi

# ---- 2. Bundled plugin/theme (version pinned by the image) ----------------------------------
sync_bundle() { # $1=plugins|themes $2=slug $3=version
  local dest="wp-content/$1/$2" marker="wp-content/$1/$2/.bundled-version"
  if [ ! -f "$marker" ] || [ "$(cat "$marker")" != "$3" ]; then
    log "installing $2 $3"
    rm -rf "$dest"
    cp -a "/opt/bundle/$1/$2" "$dest"
    echo "$3" > "$marker"
  fi
}
mkdir -p wp-content/plugins wp-content/themes wp-content/uploads
sync_bundle plugins woocommerce "$WOOCOMMERCE_VERSION"
sync_bundle themes storefront "$STOREFRONT_VERSION"

# ---- 3. Wait for MariaDB ---------------------------------------------------------------------
for i in $(seq 1 60); do
  if php -r 'mysqli_report(MYSQLI_REPORT_OFF);
      [$h,$p] = array_pad(explode(":", getenv("WORDPRESS_DB_HOST")), 2, 3306);
      $m = @new mysqli($h, getenv("WORDPRESS_DB_USER"), getenv("WORDPRESS_DB_PASSWORD"), getenv("WORDPRESS_DB_NAME"), (int)$p);
      exit($m->connect_errno ? 1 : 0);'; then break; fi
  log "waiting for database (${i}/60)"; sleep 3
  [ "$i" = 60 ] && { log "database not reachable"; exit 1; }
done

# ---- 4. Install / configure ------------------------------------------------------------------
if ! wp core is-installed 2>/dev/null; then
  log "installing WordPress at ${SITE_URL}"
  wp core install --url="$SITE_URL" --title="$STORE_TITLE" --admin_user="$WP_ADMIN_USER" \
    --admin_password="$WP_ADMIN_PASSWORD" --admin_email="$WP_ADMIN_EMAIL" --skip-email
  fresh=1
else
  fresh=0
  wp core update-db --quiet || true
fi

# Values that may change between environments (local -> VPS) are re-applied every boot.
opt home "$SITE_URL"
opt siteurl "$SITE_URL"
opt blogname "$STORE_TITLE"
opt timezone_string "$STORE_TIMEZONE"
wp rewrite structure '/%postname%/' --quiet

wp theme is-active storefront || wp theme activate storefront
wp plugin is-active woocommerce || wp plugin activate woocommerce
wp wc update --quiet 2>/dev/null || true # run pending WooCommerce DB migrations after upgrades

opt woocommerce_currency "$STORE_CURRENCY"
opt woocommerce_default_country "US:CA"
opt woocommerce_store_address "1 Demo Street"
opt woocommerce_store_city "San Francisco"
opt woocommerce_store_postcode "94105"
opt woocommerce_coming_soon no            # new stores default to "coming soon"
opt woocommerce_store_pages_only no
opt woocommerce_ship_to_countries disabled # no shipping zones needed for the demo
opt woocommerce_enable_guest_checkout yes
opt woocommerce_task_list_hidden yes
opt woocommerce_onboarding_profile '{"skipped":true}' --format=json
opt woocommerce_cod_settings \
  '{"enabled":"yes","title":"Cash on delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}' \
  --format=json

if [ "$fresh" = 1 ]; then
  wp wc tool run install_pages --user="$WP_ADMIN_USER" --quiet || true
fi

# ---- 5. REST API credentials for the MCP server ----------------------------------------------
# A dedicated shop_manager user (not the admin) owns the key: it can manage products and orders
# but cannot install plugins, edit users or change site settings.
if ! wp user get mcp-bot --field=ID >/dev/null 2>&1; then
  wp user create mcp-bot "mcp-bot@invalid.local" --role=shop_manager --display_name="MCP server" \
    --user_pass="$(php -r 'echo bin2hex(random_bytes(24));')" --quiet
fi
wp eval '
  global $wpdb;
  $table = $wpdb->prefix . "woocommerce_api_keys";
  $ck = getenv("WC_CONSUMER_KEY"); $cs = getenv("WC_CONSUMER_SECRET");
  $uid = get_user_by("login", "mcp-bot")->ID;
  $existing = $wpdb->get_row($wpdb->prepare("SELECT key_id, consumer_key, consumer_secret FROM $table WHERE description = %s", "mcp-server"));
  if ($existing && hash_equals($existing->consumer_key, wc_api_hash($ck)) && hash_equals($existing->consumer_secret, $cs)) {
    echo "[store-init] REST API key unchanged\n"; return;
  }
  $wpdb->delete($table, ["description" => "mcp-server"]);
  $wpdb->insert($table, [
    "user_id" => $uid, "description" => "mcp-server", "permissions" => "read_write",
    "consumer_key" => wc_api_hash($ck), "consumer_secret" => $cs, "truncated_key" => substr($ck, -7),
  ]);
  echo "[store-init] REST API key registered for mcp-bot\n";
'

# ---- 6. Demo catalogue -----------------------------------------------------------------------
if [ "$SEED_PRODUCTS" = "true" ] && [ "$(wp post list --post_type=product --format=count)" = "0" ]; then
  log "seeding demo products"
  wp wc product create --user="$WP_ADMIN_USER" --name="Classic Tee" --regular_price=25.00 --short_description="Soft cotton t-shirt." --quiet
  wp wc product create --user="$WP_ADMIN_USER" --name="Coffee Mug" --regular_price=12.00 --short_description="350ml ceramic mug." --quiet
  wp wc product create --user="$WP_ADMIN_USER" --name="Canvas Tote" --regular_price=18.00 --short_description="Everyday tote bag." --quiet
fi

log "done"

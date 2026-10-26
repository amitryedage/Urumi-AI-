# WordPress + WooCommerce, baked at build time so the cluster never downloads plugins at runtime
# and an image tag pins the exact WordPress/WooCommerce/Storefront versions (upgrade = new tag).
FROM wordpress:7.1.3-php8.4-apache

ARG WOOCOMMERCE_VERSION=11.2.1
ARG STOREFRONT_VERSION=4.6.2
ARG WPCLI_VERSION=2.12.0

RUN set -eux; \
    apt-get update; apt-get install -y --no-install-recommends unzip; rm -rf /var/lib/apt/lists/*; \
    curl -fsSL -o /usr/local/bin/wp "https://github.com/wp-cli/wp-cli/releases/download/v${WPCLI_VERSION}/wp-cli-${WPCLI_VERSION}.phar"; \
    chmod +x /usr/local/bin/wp; \
    mkdir -p /opt/bundle/plugins /opt/bundle/themes; \
    curl -fsSL -o /tmp/wc.zip "https://downloads.wordpress.org/plugin/woocommerce.${WOOCOMMERCE_VERSION}.zip"; \
    unzip -q /tmp/wc.zip -d /opt/bundle/plugins; \
    curl -fsSL -o /tmp/sf.zip "https://downloads.wordpress.org/theme/storefront.${STOREFRONT_VERSION}.zip"; \
    unzip -q /tmp/sf.zip -d /opt/bundle/themes; \
    rm /tmp/*.zip; \
    # Listen on 8080 so Apache can run as www-data (non-root) in Kubernetes.
    sed -i 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf; \
    sed -i 's/<VirtualHost \*:80>/<VirtualHost *:8080>/' /etc/apache2/sites-available/000-default.conf; \
    # Trust X-Forwarded-For from the ingress controller for real client IPs in logs.
    a2enmod remoteip; \
    printf 'RemoteIPHeader X-Forwarded-For\nRemoteIPInternalProxy 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16\n' > /etc/apache2/conf-enabled/remoteip.conf

COPY store-init.sh /usr/local/bin/store-init.sh
RUN chmod +x /usr/local/bin/store-init.sh

ENV WOOCOMMERCE_VERSION=${WOOCOMMERCE_VERSION} STOREFRONT_VERSION=${STOREFRONT_VERSION}
USER 33:33
EXPOSE 8080

<?php

declare(strict_types=1);

// This fixture only runs inside the authorized offline, tmpfs-backed test container.
if (
    getenv('VNX02_WORDPRESS_TESTS_CONFIRMED') !== '1'
    || getenv('VNX02_MYSQL_DATABASE') !== 'fai_vnx02_test'
    || getenv('VNX02_MYSQL_HOST') !== '127.0.0.1'
    || realpath('/var/www/html') !== '/var/www/html'
    || !is_file('/var/www/html/wp-settings.php')
) {
    fwrite(STDERR, "VNX02_WORDPRESS_TEST_GUARD_FAILED\n");
    exit(1);
}

function vnx02_install_assert(bool $value): void
{
    if (!$value) {
        throw new RuntimeException('SYNTHETIC_WORDPRESS_ASSERT_FAILED');
    }
}

define('ABSPATH', '/var/www/html/');
define('DB_NAME', 'fai_vnx02_test');
define('DB_USER', 'fai_vnx02_test');
define('DB_PASSWORD', 'synthetic-vnx02-password');
define('DB_HOST', '127.0.0.1:3306');
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');
define('WP_INSTALLING', true);
define('WP_HTTP_BLOCK_EXTERNAL', true);
define('DISABLE_WP_CRON', true);
define('AUTOMATIC_UPDATER_DISABLED', true);
define('WP_AUTO_UPDATE_CORE', false);
define('WP_HOME', 'https://wordpress.synthetic.invalid');
define('WP_SITEURL', WP_HOME);
define('FS_METHOD', 'direct');
define('WP_DEBUG', false);
define('AUTH_KEY', 'synthetic-vnx02-auth-key');
define('SECURE_AUTH_KEY', 'synthetic-vnx02-secure-auth-key');
define('LOGGED_IN_KEY', 'synthetic-vnx02-logged-in-key');
define('NONCE_KEY', 'synthetic-vnx02-nonce-key');
define('AUTH_SALT', 'synthetic-vnx02-auth-salt');
define('SECURE_AUTH_SALT', 'synthetic-vnx02-secure-auth-salt');
define('LOGGED_IN_SALT', 'synthetic-vnx02-logged-in-salt');
define('NONCE_SALT', 'synthetic-vnx02-nonce-salt');
$table_prefix = 'vnx02_wp_' . bin2hex(random_bytes(6)) . '_';
require ABSPATH . 'wp-settings.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
add_filter('pre_wp_mail', static fn (): bool => true);
add_filter('pre_http_request', static fn (): WP_Error => new WP_Error('synthetic_network_forbidden'));

wp_install('VNX02 Synthetic Test', 'vnx02_synthetic_admin', 'admin@synthetic.invalid', false, '', 'synthetic-only-password');
wp_set_current_user(1);

$zip = new ZipArchive();
vnx02_install_assert($zip->open('/workspace/dist/fai-secure-lead-connector-1.0.0.zip') === true);
vnx02_install_assert($zip->extractTo(WP_PLUGIN_DIR));
$zip->close();
$plugin = 'fai-secure-lead-connector/fai-secure-lead-connector.php';
$headers = get_plugin_data(WP_PLUGIN_DIR . '/' . $plugin, false, false);
vnx02_install_assert($headers['Version'] === '1.0.0');
vnx02_install_assert(activate_plugin($plugin, '', false, false) === null);
vnx02_install_assert(is_plugin_active($plugin));
$queue = new FAI\VNX02\QueueStore(new FAI\VNX02\WordPressDatabase($wpdb));
vnx02_install_assert($queue->isReady());
vnx02_install_assert(!FAI\VNX02\ConnectorConfig::load()->enabled);
vnx02_install_assert(!wp_next_scheduled(FAI\VNX02\Plugin::CRON_HOOK));
do_action('wpforms_process_complete', array(), array(), array('id' => 900001), 700001);
vnx02_install_assert(!$queue->hasOutstanding());

require_once __DIR__ . '/vnx02-bootstrap.php';
$configuration = vnx02_synthetic_config();
$configuration['queue_key_file'] = '/tmp/vnx02-queue-key';
$configuration['gateway_key_files']['synthetic-wordpress-v1'] = '/tmp/vnx02-gateway-key';
file_put_contents('/tmp/vnx02-queue-key', base64_encode(str_repeat("\x22", 32)));
file_put_contents('/tmp/vnx02-gateway-key', base64_encode(str_repeat("\x11", 32)));
chmod('/tmp/vnx02-queue-key', 0600);
chmod('/tmp/vnx02-gateway-key', 0600);
define('FAI_VNX02_CONNECTOR_CONFIG', $configuration);
do_action('wpforms_process_complete', vnx02_synthetic_fields(), array(), array('id' => 900001), 700001);
vnx02_install_assert($queue->hasOutstanding());
vnx02_install_assert(is_int(wp_next_scheduled(FAI\VNX02\Plugin::CRON_HOOK)));
$item = $queue->claim();
vnx02_install_assert($item !== null && $item->attempt === 1);
$queue->terminal($item, 'INVALID_REQUEST');
vnx02_install_assert(!$queue->hasOutstanding());

deactivate_plugins($plugin, false, false);
vnx02_install_assert(!is_plugin_active($plugin));
vnx02_install_assert(!wp_next_scheduled(FAI\VNX02\Plugin::CRON_HOOK));
vnx02_install_assert($queue->isReady());
vnx02_install_assert(delete_plugins(array($plugin)) === true);
vnx02_install_assert(!is_file(WP_PLUGIN_DIR . '/' . $plugin));
vnx02_install_assert($queue->isReady());
echo "VNX02 WordPress ZIP install, default-off, synthetic hook, lease, deactivate and uninstall PASS\n";

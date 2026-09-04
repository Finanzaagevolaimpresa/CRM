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

function vnx02_request(string $mode, string $prefix, int $expectedExit = 0): void
{
    $process = proc_open(array(PHP_BINARY, __FILE__, $mode, $prefix), array(
        0 => array('pipe', 'r'), 1 => array('pipe', 'w'), 2 => array('pipe', 'w'),
    ), $pipes);
    vnx02_install_assert(is_resource($process));
    fclose($pipes[0]);
    $output = stream_get_contents($pipes[1]);
    $errors = stream_get_contents($pipes[2]);
    fclose($pipes[1]);
    fclose($pipes[2]);
    $result = proc_close($process);
    if ($result !== $expectedExit) {
        fwrite(STDERR, $output . $errors);
        throw new RuntimeException('SYNTHETIC_WORDPRESS_CHILD_FAILED');
    }
    wp_cache_flush(); // The child request updates persisted cron options, not this request's cache.
}

function vnx02_cron_count(): int
{
    $count = 0;
    foreach (_get_cron_array() as $hooks) {
        $count += count($hooks[FAI\VNX02\Plugin::CRON_HOOK] ?? array());
    }
    return $count;
}

$mode = $argv[1] ?? 'install';
$child = $mode !== 'install';
vnx02_install_assert(in_array($mode, array('install', 'missing', 'disabled', 'invalid', 'enabled',
    'crash-before-claim', 'crash-after-claim', 'worker-missing-key'), true));
$table_prefix = $child ? ($argv[2] ?? '') : 'vnx02_wp_' . bin2hex(random_bytes(6)) . '_';
vnx02_install_assert(preg_match('/\Avnx02_wp_[a-f0-9]{12}_\z/D', $table_prefix) === 1);
if ($child && $mode !== 'missing') {
    $vnx02FixturePluginRoot = '/var/www/html/wp-content/plugins/fai-secure-lead-connector';
    require_once __DIR__ . '/vnx02-bootstrap.php';
    $configuration = vnx02_synthetic_config($mode !== 'disabled');
    $configuration['queue_key_file'] = '/tmp/vnx02-queue-key';
    // All child worker runs stop before transport: this synthetic private key does not exist.
    $configuration['gateway_key_files']['synthetic-wordpress-v1'] = '/tmp/vnx02-absent-gateway-key';
    if ($mode === 'invalid') {
        unset($configuration['queue_key_file']);
    }
    define('FAI_VNX02_CONNECTOR_CONFIG', $configuration);
}

define('ABSPATH', '/var/www/html/');
define('DB_NAME', 'fai_vnx02_test');
define('DB_USER', 'fai_vnx02_test');
define('DB_PASSWORD', 'synthetic-vnx02-password');
define('DB_HOST', '127.0.0.1:3306');
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');
define('WP_INSTALLING', !$child);
define('WP_HTTP_BLOCK_EXTERNAL', true);
define('DISABLE_WP_CRON', true);
define('AUTOMATIC_UPDATER_DISABLED', true);
define('WP_AUTO_UPDATE_CORE', false);
define('WP_HOME', 'https://wordpress.synthetic.invalid');
define('WP_SITEURL', WP_HOME);
define('FS_METHOD', 'direct');
define('WP_DEBUG', false);
define('WP_DISABLE_FATAL_ERROR_HANDLER', true);
define('AUTH_KEY', 'synthetic-vnx02-auth-key');
define('SECURE_AUTH_KEY', 'synthetic-vnx02-secure-auth-key');
define('LOGGED_IN_KEY', 'synthetic-vnx02-logged-in-key');
define('NONCE_KEY', 'synthetic-vnx02-nonce-key');
define('AUTH_SALT', 'synthetic-vnx02-auth-salt');
define('SECURE_AUTH_SALT', 'synthetic-vnx02-secure-auth-salt');
define('LOGGED_IN_SALT', 'synthetic-vnx02-logged-in-salt');
define('NONCE_SALT', 'synthetic-vnx02-nonce-salt');
require ABSPATH . 'wp-settings.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
add_filter('pre_wp_mail', static fn (): bool => true);
add_filter('pre_http_request', static fn (): WP_Error => new WP_Error('synthetic_network_forbidden'));

if ($child) {
    vnx02_install_assert(did_action('init') === 1);
    vnx02_install_assert(has_action('init', array(FAI\VNX02\Plugin::class, 'recoverQueue')) !== false);
    if (in_array($mode, array('crash-before-claim', 'crash-after-claim', 'worker-missing-key'), true)) {
        // WordPress consumes a single event before invoking its callback.
        $scheduled = wp_next_scheduled(FAI\VNX02\Plugin::CRON_HOOK);
        vnx02_install_assert(is_int($scheduled));
        vnx02_install_assert(wp_unschedule_event($scheduled, FAI\VNX02\Plugin::CRON_HOOK, array(), true) === true);
        if ($mode !== 'worker-missing-key') {
            $wpdb = new class ($wpdb, $mode) {
                public function __construct(private readonly object $database, private readonly string $mode) {}
                public function __get(string $name): mixed { return $this->database->$name; }
                public function __isset(string $name): bool { return isset($this->database->$name); }
                public function __set(string $name, mixed $value): void { $this->database->$name = $value; }
                public function __call(string $name, array $arguments): mixed { return $this->database->$name(...$arguments); }
                public function query(string $sql): mixed
                {
                    if ($this->mode === 'crash-before-claim' && $sql === 'START TRANSACTION') {
                        exit(86); // Abrupt process exit: Plugin::runWorker's finally cannot run.
                    }
                    $result = $this->database->query($sql);
                    if ($this->mode === 'crash-after-claim' && $sql === 'COMMIT' && $result !== false) {
                        exit(87); // The lease is durable; no transport or completion has happened.
                    }
                    return $result;
                }
            };
        }
        do_action(FAI\VNX02\Plugin::CRON_HOOK);
    }
    exit(0);
}

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
$queueTable = $wpdb->prefix . 'fai_vnx02_lead_queue';
$original = $wpdb->get_row("SELECT * FROM {$queueTable} LIMIT 1", ARRAY_A);
vnx02_install_assert(is_array($original) && $original['status'] === 'PENDING' && (int) $original['attempt_count'] === 0);

// Enabled reactivation restores preserved pending work without another WPForms submission.
deactivate_plugins($plugin, false, false);
vnx02_install_assert(vnx02_cron_count() === 0 && $queue->hasOutstanding());
vnx02_install_assert(activate_plugin($plugin, '', false, false) === null);
vnx02_install_assert(vnx02_cron_count() === 1);
echo "VNX02 WordPress enabled reactivation restores pending wake-up PASS\n";

wp_clear_scheduled_hook(FAI\VNX02\Plugin::CRON_HOOK);
foreach (array('missing', 'disabled', 'invalid') as $configurationMode) {
    vnx02_request($configurationMode, $table_prefix);
    vnx02_install_assert(vnx02_cron_count() === 0 && $queue->hasOutstanding());
}
vnx02_request('enabled', $table_prefix);
$scheduled = wp_next_scheduled(FAI\VNX02\Plugin::CRON_HOOK);
vnx02_request('enabled', $table_prefix);
vnx02_install_assert(vnx02_cron_count() === 1 && wp_next_scheduled(FAI\VNX02\Plugin::CRON_HOOK) === $scheduled);
echo "VNX02 WordPress request bootstrap is fail-closed and restores one wake-up PASS\n";

vnx02_request('crash-before-claim', $table_prefix, 86);
vnx02_install_assert(vnx02_cron_count() === 0);
vnx02_install_assert($wpdb->get_row("SELECT * FROM {$queueTable} LIMIT 1", ARRAY_A) === $original);
vnx02_request('enabled', $table_prefix);
vnx02_install_assert(vnx02_cron_count() === 1);
echo "VNX02 WordPress interrupted worker before claim recovers without submission PASS\n";

vnx02_request('crash-after-claim', $table_prefix, 87);
$leased = $wpdb->get_row("SELECT * FROM {$queueTable} LIMIT 1", ARRAY_A);
vnx02_install_assert(vnx02_cron_count() === 0 && $leased['status'] === 'LEASED' && (int) $leased['attempt_count'] === 1);
vnx02_request('enabled', $table_prefix);
vnx02_install_assert(vnx02_cron_count() === 1);
vnx02_install_assert(wp_next_scheduled(FAI\VNX02\Plugin::CRON_HOOK) > time() + 30);
vnx02_install_assert($wpdb->get_row("SELECT * FROM {$queueTable} LIMIT 1", ARRAY_A) === $leased);

// Accelerate only this synthetic row's clock; no sleeping or real data is involved.
vnx02_install_assert($wpdb->query("UPDATE {$queueTable} SET lease_expires_at=DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND)") === 1);
wp_clear_scheduled_hook(FAI\VNX02\Plugin::CRON_HOOK);
vnx02_request('enabled', $table_prefix);
vnx02_install_assert(vnx02_cron_count() === 1);
vnx02_install_assert(wp_next_scheduled(FAI\VNX02\Plugin::CRON_HOOK) <= time() + 1);
echo "VNX02 WordPress interrupted worker durable lease and expired-lease wake-up PASS\n";

for ($attempt = 2; $attempt <= FAI\VNX02\RetryPolicy::MAXIMUM_ATTEMPTS; $attempt++) {
    vnx02_request('worker-missing-key', $table_prefix);
    $row = $wpdb->get_row("SELECT * FROM {$queueTable} LIMIT 1", ARRAY_A);
    vnx02_install_assert((int) $wpdb->get_var("SELECT COUNT(*) FROM {$queueTable}") === 1);
    vnx02_install_assert((int) $row['attempt_count'] === $attempt);
    foreach (array('id', 'business_key_digest', 'submission_content_digest', 'body_hash', 'gateway_key_id') as $field) {
        vnx02_install_assert($row[$field] === $original[$field]);
    }
    if ($attempt < FAI\VNX02\RetryPolicy::MAXIMUM_ATTEMPTS) {
        vnx02_install_assert($row['status'] === 'PENDING' && $row['encrypted_body'] === $original['encrypted_body']);
        vnx02_install_assert(vnx02_cron_count() === 1);
        vnx02_install_assert($wpdb->query("UPDATE {$queueTable} SET available_at=DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND)") === 1);
    } else {
        vnx02_install_assert($row['status'] === 'EXHAUSTED' && $row['encrypted_body'] === '' && vnx02_cron_count() === 0);
    }
}
vnx02_request('enabled', $table_prefix);
do_action('wpforms_process_complete', vnx02_synthetic_fields(), array(), array('id' => 900001), 700001);
vnx02_install_assert((int) $wpdb->get_var("SELECT COUNT(*) FROM {$queueTable}") === 1 && vnx02_cron_count() === 0);
vnx02_install_assert(!$queue->hasOutstanding());
echo "VNX02 WordPress resumed cron preserves identity, retry budget and terminal replay PASS\n";

deactivate_plugins($plugin, false, false);
vnx02_install_assert(!is_plugin_active($plugin));
vnx02_install_assert(!wp_next_scheduled(FAI\VNX02\Plugin::CRON_HOOK));
vnx02_install_assert($queue->isReady());
vnx02_install_assert(delete_plugins(array($plugin)) === true);
vnx02_install_assert(!is_file(WP_PLUGIN_DIR . '/' . $plugin));
vnx02_install_assert($queue->isReady());
echo "VNX02 WordPress ZIP install, default-off, recovery lifecycle, deactivate and uninstall PASS\n";

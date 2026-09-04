<?php

declare(strict_types=1);

// Separate processes model wp-config constants changing between WordPress requests.
$scenarios = array('missing', 'disabled', 'invalid', 'empty', 'pending', 'leased', 'expired',
    'existing', 'database-unavailable', 'schedule-failure');
if ($argc === 1) {
    foreach ($scenarios as $scenario) {
        $process = proc_open(array(PHP_BINARY, __FILE__, $scenario), array(
            0 => array('pipe', 'r'), 1 => array('pipe', 'w'), 2 => array('pipe', 'w'),
        ), $pipes);
        if (!is_resource($process)) {
            throw new RuntimeException('SYNTHETIC_PROCESS_FAILED');
        }
        fclose($pipes[0]);
        $output = stream_get_contents($pipes[1]);
        $errors = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        if (proc_close($process) !== 0) {
            fwrite(STDERR, $output . $errors);
            exit(1);
        }
        echo "PASS WordPress scheduling {$scenario}\n";
    }
    echo 'VNX02 scheduling tests passed: ' . count($scenarios) . "\n";
    exit(0);
}

$scenario = $argv[1];
if (!in_array($scenario, $scenarios, true)) {
    throw new RuntimeException('SYNTHETIC_SCENARIO_INVALID');
}
require __DIR__ . '/vnx02-bootstrap.php';
require $pluginRoot . '/includes/class-plugin.php';
define('ABSPATH', '/synthetic-wordpress/');
if ($scenario !== 'missing') {
    $configuration = vnx02_synthetic_config($scenario !== 'disabled');
    if ($scenario === 'invalid') {
        unset($configuration['queue_key_file']);
    }
    define('FAI_VNX02_CONNECTOR_CONFIG', $configuration);
}

$hooks = array();
$events = array();
$scheduleFailure = $scenario === 'schedule-failure';
$wpdb = new class ($scenario) {
    public string $prefix = 'vnx02_synthetic_';
    public array $queries = array();
    private mixed $value = null;
    public function __construct(private readonly string $scenario) {}
    public function prepare(string $sql, mixed ...$unused): string { return $sql; }
    public function suppress_errors(bool $unused): bool { return false; }
    public function get_var(): mixed { return $this->value; }
    public function query(string $sql): int|false
    {
        $this->queries[] = $sql;
        if (!str_starts_with($sql, 'SELECT ')) {
            throw new RuntimeException('SYNTHETIC_RECOVERY_MUST_NOT_WRITE_QUEUE');
        }
        if ($this->scenario === 'database-unavailable') {
            return false;
        }
        $this->value = str_contains($sql, 'information_schema.tables') ? 1
            : (str_contains($sql, 'TIMESTAMPDIFF') ? ($this->scenario === 'leased' ? 45 : -1)
                : ($this->scenario === 'empty' ? 0 : 1));
        return 1;
    }
};

function vnx02_schedule_assert(bool $condition): void
{
    if (!$condition) {
        throw new RuntimeException('SYNTHETIC_SCHEDULING_ASSERT_FAILED');
    }
}
function register_activation_hook(string $unused, callable $callback): void
{
    $GLOBALS['hooks']['activation'] = $callback;
}
function register_deactivation_hook(string $unused, callable $callback): void
{
    $GLOBALS['hooks']['deactivation'] = $callback;
}
function add_action(string $hook, callable $callback, int $priority = 10, int $acceptedArgs = 1): void
{
    $GLOBALS['hooks'][$hook] = $callback;
}
function get_option(string $name, mixed $default = false): mixed
{
    return $name === 'fai_vnx02_connector_schema_version' ? '1' : $default;
}
function wp_next_scheduled(string $hook): int|false
{
    return $GLOBALS['events'][$hook] ?? false;
}
function wp_schedule_single_event(int $time, string $hook, array $args, bool $wpError): bool
{
    vnx02_schedule_assert($args === array() && $wpError);
    if ($GLOBALS['scheduleFailure']) {
        return false;
    }
    $GLOBALS['events'][$hook] = $time;
    return true;
}
function wp_unschedule_event(int $unused, string $hook, array $args, bool $wpError): bool
{
    unset($GLOBALS['events'][$hook]);
    return true;
}
function wp_clear_scheduled_hook(string $hook): void
{
    unset($GLOBALS['events'][$hook]);
}

FAI\VNX02\Plugin::register('/synthetic-wordpress/plugin.php');
vnx02_schedule_assert($hooks['init'] === array(FAI\VNX02\Plugin::class, 'recoverQueue'));
vnx02_schedule_assert(is_callable($hooks['activation']) && is_callable($hooks['deactivation']));
vnx02_schedule_assert($events === array());
if ($scenario === 'existing') {
    $events[FAI\VNX02\Plugin::CRON_HOOK] = time() + 120;
}
$before = time();
$hooks['init']();
if ($scenario === 'schedule-failure') {
    vnx02_schedule_assert($events === array());
    $scheduleFailure = false;
    $hooks['init']();
}
$shouldSchedule = in_array($scenario, array('pending', 'leased', 'expired', 'existing', 'schedule-failure'), true);
vnx02_schedule_assert(count($events) === ($shouldSchedule ? 1 : 0));
if ($shouldSchedule) {
    $delay = $scenario === 'leased' ? 45 : ($scenario === 'existing' ? 120 : 1);
    $scheduled = wp_next_scheduled(FAI\VNX02\Plugin::CRON_HOOK);
    vnx02_schedule_assert($scheduled >= $before + $delay && $scheduled <= time() + $delay);
    $queryCount = count($wpdb->queries);
    $hooks['init']();
    vnx02_schedule_assert(wp_next_scheduled(FAI\VNX02\Plugin::CRON_HOOK) === $scheduled);
    vnx02_schedule_assert(count($wpdb->queries) === $queryCount);
}
if (in_array($scenario, array('missing', 'disabled', 'invalid', 'existing'), true)) {
    vnx02_schedule_assert($wpdb->queries === array());
}
$hooks['deactivation']();
vnx02_schedule_assert($events === array());

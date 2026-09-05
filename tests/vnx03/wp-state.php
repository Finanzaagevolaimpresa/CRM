<?php

if (!defined('ABSPATH')) {
    throw new RuntimeException('VNX03_WORDPRESS_RUNTIME_MISSING');
}

global $wpdb;
$table = $wpdb->prefix . 'fai_vnx02_lead_queue';
$exists = $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $table));
if ($exists !== $table) {
    throw new RuntimeException('VNX03_QUEUE_TABLE_MISSING');
}

$rows = $wpdb->get_results(
    "SELECT status,attempt_count,last_result_code,(encrypted_body <> '') AS has_ciphertext,"
        . "(LOCATE('@vnx03.invalid', encrypted_body) > 0) AS has_plaintext_marker "
        . "FROM {$table} ORDER BY id",
    ARRAY_A
);
if (!is_array($rows)) {
    throw new RuntimeException('VNX03_QUEUE_READ_FAILED');
}

$safeRows = array_map(static fn (array $row): array => array(
    'status' => (string) $row['status'],
    'attempt' => (int) $row['attempt_count'],
    'result' => $row['last_result_code'] === null ? null : (string) $row['last_result_code'],
    'ciphertext' => (int) $row['has_ciphertext'] === 1,
    'plaintextMarker' => (int) $row['has_plaintext_marker'] === 1,
), $rows);
$nextDelay = $wpdb->get_var(
    "SELECT TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(6),MIN(CASE WHEN status='PENDING' "
        . "THEN available_at ELSE lease_expires_at END)) FROM {$table} "
        . "WHERE status IN ('PENDING','LEASED')"
);
if ($nextDelay !== null && !is_numeric($nextDelay)) {
    throw new RuntimeException('VNX03_QUEUE_DELAY_READ_FAILED');
}

echo wp_json_encode(array(
    'rows' => $safeRows,
    'pluginActive' => in_array(
        'fai-secure-lead-connector/fai-secure-lead-connector.php',
        (array) get_option('active_plugins', array()),
        true
    ),
    'scheduled' => is_int(wp_next_scheduled('fai_vnx02_secure_lead_queue')),
    'nextDelaySeconds' => $nextDelay === null ? null : max(1, min(3600, (int) $nextDelay)),
    'schemaVersion' => (string) get_option('fai_vnx02_connector_schema_version', ''),
), JSON_UNESCAPED_SLASHES) . PHP_EOL;

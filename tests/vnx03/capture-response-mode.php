<?php
declare(strict_types=1);

// Change only an existing synthetic fixture; never usable against a public WordPress.
$mode = getenv('VNX03_CAPTURE_RESPONSE_MODE');
if (!defined('WP_ENVIRONMENT_TYPE') || WP_ENVIRONMENT_TYPE !== 'local'
    || !defined('WP_HOME') || preg_match('/\Ahttp:\/\/127\.0\.0\.1:[1-9][0-9]{1,4}\z/D', WP_HOME) !== 1
    || !in_array($mode, array('message', 'redirect', 'ajax'), true)) {
    throw new RuntimeException('VNX03_CAPTURE_FIXTURE_TARGET_INVALID');
}
$form = get_post(900001);
if (!$form || $form->post_type !== 'wpforms') {
    throw new RuntimeException('VNX03_CAPTURE_FIXTURE_FORM_MISSING');
}
$data = wpforms_decode($form->post_content);
if (($data['meta']['template'] ?? null) !== 'vnx03-synthetic') {
    throw new RuntimeException('VNX03_CAPTURE_FIXTURE_IDENTITY_INVALID');
}
$data['settings']['ajax_submit'] = $mode === 'ajax' ? '1' : '0';
$data['settings']['confirmations'] = array('1' => array(
    'type' => $mode === 'redirect' ? 'redirect' : 'message',
    'message' => 'VNX03_SYNTHETIC_CONFIRMATION', 'message_scroll' => '1',
    'redirect' => WP_HOME . '/vnx03-capture-must-not-redirect/',
));
if (wp_update_post(array('ID' => 900001, 'post_content' => wp_slash(wpforms_encode($data))), true) !== 900001) {
    throw new RuntimeException('VNX03_CAPTURE_FIXTURE_UPDATE_FAILED');
}
echo "VNX03_CAPTURE_FIXTURE_READY\n";

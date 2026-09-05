<?php

declare(strict_types=1);

$vnx03PublicUrl = getenv('VNX03_WORDPRESS_PUBLIC_URL');
if (!is_string($vnx03PublicUrl) || preg_match('/\Ahttp:\/\/127\.0\.0\.1:[1-9][0-9]{1,4}\z/D', $vnx03PublicUrl) !== 1) {
    throw new RuntimeException('VNX03_WORDPRESS_PUBLIC_URL_INVALID');
}

define('WP_HOME', $vnx03PublicUrl);
define('WP_SITEURL', $vnx03PublicUrl);
define('WP_ENVIRONMENT_TYPE', 'local');
define('DISABLE_WP_CRON', true);
define('AUTOMATIC_UPDATER_DISABLED', true);
define('WP_HTTP_BLOCK_EXTERNAL', true);

$vnx03ScenarioPath = '/run/vnx03-control/connector-scenario';
$vnx03Scenario = is_file($vnx03ScenarioPath)
    ? trim((string) file_get_contents($vnx03ScenarioPath))
    : 'disabled';
$vnx03AllowedScenarios = array(
    'disabled',
    'normal',
    'bad_hmac',
    'untrusted_ca',
    'wrong_hostname',
);
if (!in_array($vnx03Scenario, $vnx03AllowedScenarios, true)) {
    $vnx03Scenario = 'disabled';
}

$vnx03GatewayHost = match ($vnx03Scenario) {
    'untrusted_ca' => 'untrusted-gateway.vnx03.test',
    'wrong_hostname' => 'wrong-host.vnx03.test',
    default => 'gateway.vnx03.test',
};
$vnx03GatewayKeyFile = $vnx03Scenario === 'bad_hmac'
    ? '/run/vnx03-secrets/gateway-key.invalid.b64'
    : '/run/vnx03-secrets/gateway-key.valid.b64';

define('FAI_VNX02_CONNECTOR_CONFIG', array(
    'version' => 1,
    'enabled' => $vnx03Scenario !== 'disabled',
    'gateway_url' => 'https://' . $vnx03GatewayHost . ':8443/api/integrations/website/leads/v2',
    'active_key_id' => 'vnx03-wordpress-key-v1',
    'gateway_key_files' => array(
        'vnx03-wordpress-key-v1' => $vnx03GatewayKeyFile,
    ),
    'queue_key_file' => '/run/vnx03-secrets/queue-key.b64',
    'forms' => array(
        900001 => array(
            'form_code' => 'VNX03_SYNTHETIC_WPFORMS',
            'form_version' => 'v1',
            'field_map' => array(
                'firstName' => 1,
                'lastName' => 2,
                'email' => 3,
                'companyName' => 4,
                'phone' => 5,
                'requestedAmount' => 6,
                'message' => 7,
            ),
            'requested_amount_mode' => 'EUR_MAJOR_DECIMAL',
            'privacy' => array(
                'service' => array(
                    'field_id' => 8,
                    'accepted_values' => array('SYNTHETIC_SERVICE_ACCEPTED'),
                    'notice_code' => 'SYNTHETIC_PRIVACY_NOTICE',
                    'notice_version' => 'v1',
                    'purpose_code' => 'SERVICE_REQUEST_FOLLOW_UP',
                    'legal_basis_code' => 'PRE_CONTRACTUAL_MEASURES',
                    'evidence_kind' => 'NOTICE_ACKNOWLEDGEMENT',
                ),
                'marketing' => array(
                    'field_id' => 9,
                    'granted_values' => array('SYNTHETIC_MARKETING_GRANTED'),
                    'denied_values' => array('SYNTHETIC_MARKETING_DENIED'),
                    'notice_code' => 'SYNTHETIC_MARKETING_NOTICE',
                    'notice_version' => 'v1',
                    'purpose_code' => 'DIRECT_MARKETING',
                    'legal_basis_code' => 'CONSENT',
                    'evidence_kind' => 'CONSENT',
                ),
            ),
            'catalog_reference' => null,
        ),
    ),
));

unset(
    $vnx03AllowedScenarios,
    $vnx03GatewayHost,
    $vnx03GatewayKeyFile,
    $vnx03PublicUrl,
    $vnx03Scenario,
    $vnx03ScenarioPath
);

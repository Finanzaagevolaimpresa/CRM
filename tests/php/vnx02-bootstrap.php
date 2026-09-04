<?php

declare(strict_types=1);

use FAI\VNX02\ConnectorConfig;

$pluginRoot = dirname(__DIR__, 2) . '/integrations/wordpress/fai-secure-lead-connector';
foreach (array(
    'class-connector-error.php',
    'class-runtime-requirements.php',
    'class-event-contract.php',
    'class-connector-config.php',
    'class-secret-store.php',
    'class-gateway-client.php',
    'class-database.php',
    'class-queue-store.php',
    'class-worker.php',
    'class-safe-logger.php',
) as $file) {
    if (!class_exists('FAI\\VNX02\\Plugin', false)) {
        require_once $pluginRoot . '/includes/' . $file;
    }
}
/**
 * @return array<string, mixed>
 */
function vnx02_synthetic_config(bool $enabled = true): array
{
    return array(
        'version' => ConnectorConfig::VERSION,
        'enabled' => $enabled,
        'gateway_url' => 'https://crm.synthetic.invalid/api/integrations/website/leads/v2',
        'active_key_id' => 'synthetic-wordpress-v1',
        'gateway_key_files' => array(
            'synthetic-wordpress-v1' => '/tmp/vnx02-gateway.synthetic.key',
        ),
        'queue_key_file' => '/tmp/vnx02-queue.synthetic.key',
        'forms' => array(
            900001 => array(
                'form_code' => 'SYNTHETIC_FORM',
                'form_version' => 'v1',
                'field_map' => array(
                    'firstName' => 1,
                    'lastName' => 2,
                    'companyName' => 3,
                    'email' => 4,
                    'phone' => 5,
                    'city' => 6,
                    'region' => 7,
                    'interestText' => 8,
                    'serviceInterestText' => 9,
                    'requestedAmount' => 10,
                    'message' => 11,
                    'sourcePagePath' => 12,
                ),
                'requested_amount_mode' => 'EUR_MAJOR_DECIMAL',
                'privacy' => array(
                    'service' => array(
                        'field_id' => 13,
                        'accepted_values' => array('SYNTHETIC_SERVICE_ACCEPTED'),
                        'notice_code' => 'SYNTHETIC_PRIVACY_NOTICE',
                        'notice_version' => 'v1',
                        'purpose_code' => 'SERVICE_REQUEST_FOLLOW_UP',
                        'legal_basis_code' => 'PRE_CONTRACTUAL_MEASURES',
                        'evidence_kind' => 'NOTICE_ACKNOWLEDGEMENT',
                    ),
                    'marketing' => array(
                        'field_id' => 14,
                        'granted_values' => array('SYNTHETIC_MARKETING_GRANTED'),
                        'denied_values' => array('', 'SYNTHETIC_MARKETING_DENIED'),
                        'notice_code' => 'SYNTHETIC_MARKETING_NOTICE',
                        'notice_version' => 'v1',
                        'purpose_code' => 'DIRECT_MARKETING',
                        'legal_basis_code' => 'CONSENT',
                        'evidence_kind' => 'CONSENT',
                    ),
                ),
                'catalog_reference' => array(
                    'catalogVersion' => '2026-07-12-v1',
                    'serviceCode' => 'verifica_ai_essenziale',
                    'serviceVersion' => 1,
                ),
            ),
        ),
    );
}

/**
 * @return array<int, array{value: string}>
 */
function vnx02_synthetic_fields(string $marketing = 'SYNTHETIC_MARKETING_DENIED'): array
{
    return array(
        1 => array('value' => ' Synthetic '),
        2 => array('value' => 'Lead'),
        3 => array('value' => 'Synthetic Company'),
        4 => array('value' => 'SYNTHETIC.LEAD@N10.INVALID'),
        5 => array('value' => '+39 333 000 0010'),
        6 => array('value' => 'Synthetic City'),
        7 => array('value' => 'Synthetic Region'),
        8 => array('value' => 'Synthetic business interest'),
        9 => array('value' => 'Synthetic service request'),
        10 => array('value' => '50000,00'),
        11 => array('value' => 'Synthetic-only VNX-02 contract fixture.'),
        12 => array('value' => '/synthetic-contact/'),
        13 => array('value' => 'SYNTHETIC_SERVICE_ACCEPTED'),
        14 => array('value' => $marketing),
    );
}

function vnx02_deterministic_random(): callable
{
    $values = array(
        hex2bin('00000000000000000000000000000000'),
        hex2bin('11111111111111111111111111111111'),
    );
    return static function (int $length) use (&$values): string {
        $value = array_shift($values);
        if (!is_string($value) || strlen($value) !== $length) {
            throw new RuntimeException('SYNTHETIC_RANDOM_EXHAUSTED');
        }
        return $value;
    };
}

<?php

/**
 * Synthetic, non-operational example only.
 *
 * Copy the structure into wp-config.php, replace every synthetic reference with
 * an independently approved value, keep enabled=false, and provision the two
 * private key files only during a separately authorized installation/cutover.
 */
define('FAI_VNX02_CONNECTOR_CONFIG', array(
    'version' => 1,
    'enabled' => false,
    'gateway_url' => 'https://crm.synthetic.invalid/api/integrations/website/leads/v2',
    'active_key_id' => 'synthetic-wordpress-v1',
    'gateway_key_files' => array(
        'synthetic-wordpress-v1' => '/run/secrets/fai-vnx02-gateway.synthetic.example',
    ),
    'queue_key_file' => '/run/secrets/fai-vnx02-queue.synthetic.example',
    'forms' => array(
        900001 => array(
            'form_code' => 'SYNTHETIC_FORM',
            'form_version' => 'v1',
            'field_map' => array(
                'firstName' => 900101,
                'lastName' => 900102,
                'companyName' => 900103,
                'email' => 900104,
                'phone' => 900105,
                'city' => 900106,
                'region' => 900107,
                'interestText' => 900108,
                'serviceInterestText' => 900109,
                'requestedAmount' => 900110,
                'message' => 900111,
                'sourcePagePath' => 900112,
            ),
            'requested_amount_mode' => 'EUR_MAJOR_DECIMAL',
            'privacy' => array(
                'service' => array(
                    'field_id' => 900113,
                    'accepted_values' => array('SYNTHETIC_SERVICE_ACCEPTED'),
                    'notice_code' => 'SYNTHETIC_PRIVACY_NOTICE',
                    'notice_version' => 'v1',
                    'purpose_code' => 'SERVICE_REQUEST_FOLLOW_UP',
                    'legal_basis_code' => 'PRE_CONTRACTUAL_MEASURES',
                    'evidence_kind' => 'NOTICE_ACKNOWLEDGEMENT',
                ),
                'marketing' => array(
                    'field_id' => 900114,
                    'granted_values' => array('SYNTHETIC_MARKETING_GRANTED'),
                    'denied_values' => array('', 'SYNTHETIC_MARKETING_DENIED'),
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

<?php

declare(strict_types=1);

if (!defined('ABSPATH') || !function_exists('wpforms')) {
    throw new RuntimeException('VNX03_WPFORMS_RUNTIME_MISSING');
}

wp_set_current_user(1);

/**
 * @return array<string, mixed>
 */
function vnx03_form_data(string $title): array
{
    return array(
        'fields' => array(
            '1' => array('id' => '1', 'type' => 'text', 'label' => 'First name', 'required' => '1', 'size' => 'medium'),
            '2' => array('id' => '2', 'type' => 'text', 'label' => 'Last name', 'required' => '1', 'size' => 'medium'),
            '3' => array('id' => '3', 'type' => 'email', 'label' => 'Email', 'required' => '1', 'size' => 'medium'),
            '4' => array('id' => '4', 'type' => 'text', 'label' => 'Company', 'required' => '0', 'size' => 'medium'),
            '5' => array('id' => '5', 'type' => 'text', 'label' => 'Phone', 'required' => '0', 'size' => 'medium'),
            '6' => array('id' => '6', 'type' => 'text', 'label' => 'Requested amount', 'required' => '0', 'size' => 'medium'),
            '7' => array('id' => '7', 'type' => 'textarea', 'label' => 'Message', 'required' => '0', 'size' => 'medium'),
            '8' => array(
                'id' => '8',
                'type' => 'radio',
                'label' => 'Service privacy',
                'required' => '0',
                'show_values' => '1',
                'choices' => array(
                    '1' => array('label' => 'SYNTHETIC_SERVICE_ACCEPTED', 'value' => 'SYNTHETIC_SERVICE_ACCEPTED'),
                ),
            ),
            '9' => array(
                'id' => '9',
                'type' => 'radio',
                'label' => 'Marketing privacy',
                'required' => '0',
                'show_values' => '1',
                'choices' => array(
                    '1' => array('label' => 'SYNTHETIC_MARKETING_GRANTED', 'value' => 'SYNTHETIC_MARKETING_GRANTED'),
                    '2' => array('label' => 'SYNTHETIC_MARKETING_DENIED', 'value' => 'SYNTHETIC_MARKETING_DENIED'),
                ),
            ),
        ),
        'field_id' => 10,
        'settings' => array(
            'form_title' => $title,
            'form_desc' => 'Synthetic VNX-03 qualification form.',
            'submit_text' => 'Submit synthetic request',
            'submit_text_processing' => 'Submitting synthetic request',
            'notification_enable' => '0',
            'notifications' => array(),
            'confirmations' => array(
                '1' => array(
                    'type' => 'message',
                    'message' => 'VNX03_SYNTHETIC_CONFIRMATION',
                    'message_scroll' => '1',
                ),
            ),
            'ajax_submit' => '0',
            'antispam_v3' => '0',
        ),
        'meta' => array('template' => 'vnx03-synthetic'),
    );
}

/**
 * @param array<string, mixed> $data
 */
function vnx03_create_form(int $id, string $title, array $data): void
{
    if (get_post($id) !== null) {
        throw new RuntimeException('VNX03_FORM_ID_NOT_FRESH');
    }
    $data['id'] = $id;
    $created = wpforms()->form->add(
        $title,
        array(
            'import_id' => $id,
            'post_status' => 'publish',
            'post_content' => wpforms_encode($data),
        ),
        array('builder' => true)
    );
    if (!is_int($created) || $created !== $id) {
        throw new RuntimeException('VNX03_FORM_CREATE_FAILED');
    }
    $stored = wpforms()->form->get($id, array('content_only' => true, 'cap' => false));
    if (
        !is_array($stored)
        || ($stored['id'] ?? null) !== $id
        || count($stored['fields'] ?? array()) !== 9
        || ($stored['settings']['ajax_submit'] ?? null) !== '0'
    ) {
        throw new RuntimeException('VNX03_FORM_VERIFY_FAILED');
    }
}

/**
 * @param array<string, mixed> $post
 */
function vnx03_create_page(array $post, int $expectedId): void
{
    if (get_post($expectedId) !== null) {
        throw new RuntimeException('VNX03_PAGE_ID_NOT_FRESH');
    }
    $created = wp_insert_post(array_merge($post, array('import_id' => $expectedId)), true);
    if (is_wp_error($created) || $created !== $expectedId) {
        throw new RuntimeException('VNX03_PAGE_CREATE_FAILED');
    }
}

vnx03_create_form(900001, 'VNX03 Allowed', vnx03_form_data('VNX03 Allowed'));
vnx03_create_form(900002, 'VNX03 Excluded', vnx03_form_data('VNX03 Excluded'));

vnx03_create_page(array(
    'post_type' => 'page',
    'post_status' => 'publish',
    'post_title' => 'VNX03 Allowed',
    'post_name' => 'vnx03-allowed',
    'post_content' => '[wpforms id="900001" title="false"]',
), 910001);
vnx03_create_page(array(
    'post_type' => 'page',
    'post_status' => 'publish',
    'post_title' => 'VNX03 Excluded',
    'post_name' => 'vnx03-excluded',
    'post_content' => '[wpforms id="900002" title="false"]',
), 910002);

flush_rewrite_rules(false);

echo wp_json_encode(array('forms' => 2, 'pages' => 2), JSON_UNESCAPED_SLASHES) . PHP_EOL;

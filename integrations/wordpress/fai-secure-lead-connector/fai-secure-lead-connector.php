<?php
/**
 * Plugin Name: FAI Secure Lead Connector
 * Description: Server-side, fail-closed WPForms producer for fai.lead-event.v1 and the N12 gateway.
 * Version: 1.0.0
 * Requires at least: 6.5
 * Requires PHP: 8.1
 * Text Domain: fai-secure-lead-connector
 */

declare(strict_types=1);

if (!defined('ABSPATH')) {
    exit;
}

require_once __DIR__ . '/includes/class-connector-error.php';
require_once __DIR__ . '/includes/class-runtime-requirements.php';
require_once __DIR__ . '/includes/class-event-contract.php';
require_once __DIR__ . '/includes/class-connector-config.php';
require_once __DIR__ . '/includes/class-secret-store.php';
require_once __DIR__ . '/includes/class-gateway-client.php';
require_once __DIR__ . '/includes/class-database.php';
require_once __DIR__ . '/includes/class-queue-store.php';
require_once __DIR__ . '/includes/class-worker.php';
require_once __DIR__ . '/includes/class-safe-logger.php';
require_once __DIR__ . '/includes/class-plugin.php';

\FAI\VNX02\Plugin::register(__FILE__);

<?php

declare(strict_types=1);

use FAI\VNX02\ConnectorConfig;
use FAI\VNX02\EventContract;
use FAI\VNX02\GatewayProtocol;

require_once __DIR__ . '/vnx02-bootstrap.php';

$config = ConnectorConfig::fromArray(vnx02_synthetic_config());
$fields = vnx02_synthetic_fields();
$fields[1]['value'] = " Cafe\u{0301} \u{1F600} \u{FEFF}";
$fields[5]['value'] = "+39\u{FEFF}333\u{00A0}000\t0010";
$fields[10]['value'] = '90071992547409,91';
$envelope = EventContract::create(
    $fields,
    900001,
    700001,
    $config->form(900001),
    new DateTimeImmutable('2026-08-21T12:00:00.000Z'),
    vnx02_deterministic_random()
);
$keyId = 'synthetic-wordpress-v1';
$timestamp = '1787313600';
$nonce = '0123456789abcdef0123456789abcdef';
$secret = hex2bin('1111111111111111111111111111111111111111111111111111111111111111');
$signedBytes = GatewayProtocol::signedBytes($keyId, $timestamp, $nonce, $envelope->body);
$output = array(
    'body' => $envelope->body,
    'businessKeyDigest' => $envelope->businessKeyDigest,
    'payloadHash' => $envelope->payloadHash,
    'bodyHash' => $envelope->bodyHash,
    'keyId' => $keyId,
    'timestamp' => $timestamp,
    'nonce' => $nonce,
    'signedBytesBase64' => base64_encode($signedBytes),
    'signature' => GatewayProtocol::signature($secret, $signedBytes),
);
echo json_encode($output, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);

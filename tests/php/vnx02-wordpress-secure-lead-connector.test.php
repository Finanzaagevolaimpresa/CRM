<?php

declare(strict_types=1);

use FAI\VNX02\CanonicalJson;
use FAI\VNX02\ConnectorConfig;
use FAI\VNX02\ConnectorException;
use FAI\VNX02\DeliveryResult;
use FAI\VNX02\EventContract;
use FAI\VNX02\GatewayClient;
use FAI\VNX02\GatewayProtocol;
use FAI\VNX02\GatewayTransport;
use FAI\VNX02\QueueCipher;
use FAI\VNX02\RetryPolicy;
use FAI\VNX02\SafeLogger;
use FAI\VNX02\SecretStore;
use FAI\VNX02\TransportResponse;

require_once __DIR__ . '/vnx02-bootstrap.php';

$tests = array();

function vnx02_test(string $name, callable $test): void
{
    global $tests;
    $tests[] = array($name, $test);
}

function vnx02_same(mixed $expected, mixed $actual): void
{
    if ($expected !== $actual) {
        throw new RuntimeException('SYNTHETIC_ASSERT_SAME_FAILED');
    }
}

function vnx02_true(bool $condition): void
{
    if (!$condition) {
        throw new RuntimeException('SYNTHETIC_ASSERT_TRUE_FAILED');
    }
}

function vnx02_throws(string $safeCode, callable $operation): void
{
    try {
        $operation();
    } catch (ConnectorException $error) {
        vnx02_same($safeCode, $error->safeCode);
        vnx02_same($safeCode, $error->getMessage());
        return;
    }
    throw new RuntimeException('SYNTHETIC_EXPECTED_EXCEPTION_MISSING');
}

final class Vnx02RecordingTransport implements GatewayTransport
{
    /** @var array<string, mixed>|null */
    public ?array $request = null;

    public function __construct(
        private readonly ?TransportResponse $response = null,
        private readonly bool $fail = false
    ) {
    }

    public function post(string $url, array $headers, string $body, int $timeoutMilliseconds): TransportResponse
    {
        $this->request = compact('url', 'headers', 'body', 'timeoutMilliseconds');
        if ($this->fail) {
            throw new RuntimeException('synthetic.lead@n10.invalid secret path payload');
        }
        return $this->response ?? new TransportResponse(
            202,
            '{"ok":true,"receipt":"slg2_00000000000000000000000000000000"}',
            null
        );
    }
}

vnx02_test('configuration is default-off and rejects incomplete or semantically incompatible activation', function (): void {
    $disabled = ConnectorConfig::fromArray(vnx02_synthetic_config(false));
    vnx02_same(false, $disabled->enabled);
    $unknown = vnx02_synthetic_config();
    $unknown['unexpected'] = true;
    vnx02_throws(ConnectorException::CONFIGURATION_INVALID, fn () => ConnectorConfig::fromArray($unknown));
    $wrongPrivacy = vnx02_synthetic_config();
    $wrongPrivacy['forms'][900001]['privacy']['service']['legal_basis_code'] = 'CONSENT';
    vnx02_throws(
        ConnectorException::CONFIGURATION_INVALID,
        fn () => ConnectorConfig::fromArray($wrongPrivacy)
    );
    $emptyAcknowledgement = vnx02_synthetic_config();
    $emptyAcknowledgement['forms'][900001]['privacy']['service']['accepted_values'] = array('');
    vnx02_throws(ConnectorException::CONFIGURATION_INVALID, fn () => ConnectorConfig::fromArray($emptyAcknowledgement));
    $emptyConsent = vnx02_synthetic_config();
    $emptyConsent['forms'][900001]['privacy']['marketing']['granted_values'] = array('');
    $emptyConsent['forms'][900001]['privacy']['marketing']['denied_values'] = array('SYNTHETIC_MARKETING_DENIED');
    vnx02_throws(ConnectorException::CONFIGURATION_INVALID, fn () => ConnectorConfig::fromArray($emptyConsent));
    $duplicateField = vnx02_synthetic_config();
    $duplicateField['forms'][900001]['privacy']['service']['field_id'] = 4;
    vnx02_throws(
        ConnectorException::CONFIGURATION_INVALID,
        fn () => ConnectorConfig::fromArray($duplicateField)
    );
    $http = vnx02_synthetic_config();
    $http['gateway_url'] = 'http://crm.synthetic.invalid/api/integrations/website/leads/v2';
    vnx02_throws(ConnectorException::CONFIGURATION_INVALID, fn () => ConnectorConfig::fromArray($http));
    $reusedKeyFile = vnx02_synthetic_config();
    $reusedKeyFile['queue_key_file'] = $reusedKeyFile['gateway_key_files']['synthetic-wordpress-v1'];
    vnx02_throws(
        ConnectorException::CONFIGURATION_INVALID,
        fn () => ConnectorConfig::fromArray($reusedKeyFile)
    );
});

vnx02_test('WPForms fields become a strict canonical N10 event with stable source identity', function (): void {
    $config = ConnectorConfig::fromArray(vnx02_synthetic_config());
    $envelope = EventContract::create(
        vnx02_synthetic_fields(),
        900001,
        700001,
        $config->form(900001),
        new DateTimeImmutable('2026-08-21T12:00:00.000Z'),
        vnx02_deterministic_random()
    );
    vnx02_same($envelope->body, CanonicalJson::encode($envelope->event));
    vnx02_same($envelope->body, EventContract::parseAndVerify($envelope->body)->body);
    vnx02_same('fai.lead-event.v1', $envelope->event['schemaVersion']);
    vnx02_same('00000000-0000-4000-8000-000000000000', $envelope->event['eventId']);
    vnx02_same('11111111-1111-4111-9111-111111111111', $envelope->event['businessCorrelationId']);
    vnx02_same('WPFORM:900001:ENTRY:700001', $envelope->event['source']['submissionId']);
    vnx02_same('synthetic.lead@n10.invalid', $envelope->event['payload']['email']);
    vnx02_same('+393330000010', $envelope->event['payload']['phone']);
    vnx02_same(5000000, $envelope->event['payload']['requestedAmount']['minorUnits']);
    vnx02_same('DENIED', $envelope->event['privacy']['marketing']['decision']);
    vnx02_true(strlen($envelope->body) <= EventContract::MAXIMUM_BODY_BYTES);
    vnx02_true(preg_match('/\A[0-9a-f]{64}\z/D', $envelope->businessKeyDigest) === 1);
});

vnx02_test('privacy, contact, source path, unknown fields and body tamper fail closed', function (): void {
    $config = ConnectorConfig::fromArray(vnx02_synthetic_config());
    $form = $config->form(900001);
    $missingPrivacy = vnx02_synthetic_fields();
    unset($missingPrivacy[14]);
    vnx02_throws(
        ConnectorException::PRIVACY_MAPPING_INVALID,
        fn () => EventContract::create($missingPrivacy, 900001, 1, $form)
    );
    $unknownPrivacy = vnx02_synthetic_fields('SYNTHETIC_UNMAPPED_CHOICE');
    vnx02_throws(
        ConnectorException::PRIVACY_MAPPING_INVALID,
        fn () => EventContract::create($unknownPrivacy, 900001, 1, $form)
    );
    $noContact = vnx02_synthetic_fields();
    $noContact[4]['value'] = '';
    $noContact[5]['value'] = '';
    vnx02_throws(
        ConnectorException::LEAD_EVENT_INVALID,
        fn () => EventContract::create($noContact, 900001, 1, $form)
    );
    $badPath = vnx02_synthetic_fields();
    $badPath[12]['value'] = '/safe/%2e%2e/private';
    vnx02_throws(
        ConnectorException::LEAD_EVENT_INVALID,
        fn () => EventContract::create($badPath, 900001, 1, $form)
    );
    $unicodeEmail = vnx02_synthetic_fields();
    $unicodeEmail[4]['value'] = 'synthétic@n10.invalid';
    vnx02_throws(
        ConnectorException::LEAD_EVENT_INVALID,
        fn () => EventContract::create($unicodeEmail, 900001, 1, $form)
    );
    $ecmascriptWhitespace = vnx02_synthetic_fields();
    $ecmascriptWhitespace[5]['value'] = "+39\u{FEFF}333\u{00A0}000\t0010";
    $whitespaceEnvelope = EventContract::create($ecmascriptWhitespace, 900001, 2, $form);
    vnx02_same('+393330000010', $whitespaceEnvelope->event['payload']['phone']);
    $envelope = EventContract::create(vnx02_synthetic_fields(), 900001, 1, $form);
    $tampered = str_replace('synthetic.lead@n10.invalid', 'other@n10.invalid', $envelope->body);
    vnx02_throws(ConnectorException::LEAD_EVENT_INVALID, fn () => EventContract::parseAndVerify($tampered));
    $decoded = json_decode($envelope->body, true, 32, JSON_THROW_ON_ERROR);
    $decoded['payload']['unknown'] = 'synthetic';
    vnx02_throws(
        ConnectorException::LEAD_EVENT_INVALID,
        fn () => EventContract::parseAndVerify(CanonicalJson::encode($decoded))
    );
});

vnx02_test('queue encryption is bound, non-plaintext and detects tamper', function (): void {
    $config = ConnectorConfig::fromArray(vnx02_synthetic_config());
    $envelope = EventContract::create(vnx02_synthetic_fields(), 900001, 1, $config->form(900001));
    $queueSecret = hex2bin(str_repeat('22', 32));
    $ciphertext = QueueCipher::encrypt(
        $envelope->body,
        $envelope->businessKeyDigest,
        $envelope->bodyHash,
        'synthetic-wordpress-v1',
        $queueSecret,
        static fn (int $length): string => str_repeat("\x33", $length)
    );
    vnx02_true(!str_contains($ciphertext, 'synthetic.lead@n10.invalid'));
    vnx02_same($envelope->body, QueueCipher::decrypt(
        $ciphertext,
        $envelope->businessKeyDigest,
        $envelope->bodyHash,
        'synthetic-wordpress-v1',
        $queueSecret
    ));
    $packed = base64_decode($ciphertext, true);
    $packed[strlen($packed) - 1] = chr(ord($packed[strlen($packed) - 1]) ^ 1);
    $tampered = base64_encode($packed);
    vnx02_throws(
        ConnectorException::QUEUE_INTEGRITY_FAILURE,
        fn () => QueueCipher::decrypt(
            $tampered,
            $envelope->businessKeyDigest,
            $envelope->bodyHash,
            'synthetic-wordpress-v1',
            $queueSecret
        )
    );
    vnx02_throws(
        ConnectorException::QUEUE_INTEGRITY_FAILURE,
        fn () => QueueCipher::encrypt(
            $envelope->body,
            $envelope->businessKeyDigest,
            str_repeat('0', 64),
            'synthetic-wordpress-v1',
            $queueSecret
        )
    );
});

vnx02_test('Unicode normalization and integer amount boundaries match the N10 subset', function (): void {
    $form = ConnectorConfig::fromArray(vnx02_synthetic_config())->form(900001);
    $fields = vnx02_synthetic_fields();
    $fields[1]['value'] = "  Cafe\u{0301} \u{1F600}  ";
    $fields[10]['value'] = '90071992547409,91';
    $envelope = EventContract::create($fields, 900001, 1, $form);
    vnx02_same("Café \u{1F600}", $envelope->event['payload']['firstName']);
    vnx02_same(9007199254740991, $envelope->event['payload']['requestedAmount']['minorUnits']);
    vnx02_same($envelope->body, EventContract::parseAndVerify($envelope->body)->body);
    $fields[10]['value'] = '90071992547409,92';
    vnx02_throws(ConnectorException::FORM_MAPPING_INVALID, fn () => EventContract::create($fields, 900001, 2, $form));
    $fields[10]['value'] = '1.000,00';
    vnx02_throws(ConnectorException::FORM_MAPPING_INVALID, fn () => EventContract::create($fields, 900001, 2, $form));
    $fields[10]['value'] = '';
    $fields[1]['value'] = str_repeat("\u{1F600}", 501);
    vnx02_throws(ConnectorException::LEAD_EVENT_INVALID, fn () => EventContract::create($fields, 900001, 2, $form));
});

vnx02_test('WPForms Lite submissions get independent identities retained by their queued bodies', function (): void {
    $form = ConnectorConfig::fromArray(vnx02_synthetic_config())->form(900001);
    $first = EventContract::create(vnx02_synthetic_fields(), 900001, 0, $form);
    $second = EventContract::create(vnx02_synthetic_fields(), 900001, 0, $form);
    vnx02_true(str_starts_with($first->event['source']['submissionId'], 'WPFORM:900001:EPHEMERAL:'));
    vnx02_true($first->businessKeyDigest !== $second->businessKeyDigest);
    vnx02_same($first->body, EventContract::parseAndVerify($first->body)->body);
});

vnx02_test('N12 signature covers the exact body and every required header', function (): void {
    $config = ConnectorConfig::fromArray(vnx02_synthetic_config());
    $envelope = EventContract::create(vnx02_synthetic_fields(), 900001, 1, $config->form(900001));
    $transport = new Vnx02RecordingTransport();
    $client = new GatewayClient($transport);
    $secret = hex2bin(str_repeat('11', 32));
    $result = $client->deliver(
        $config->gatewayUrl,
        'synthetic-wordpress-v1',
        $secret,
        $envelope->body,
        1787313600,
        '0123456789abcdef0123456789abcdef'
    );
    vnx02_same(DeliveryResult::DELIVERED, $result->disposition);
    vnx02_same(GatewayProtocol::TIMEOUT_MILLISECONDS, $transport->request['timeoutMilliseconds']);
    vnx02_same($envelope->body, $transport->request['body']);
    $headers = $transport->request['headers'];
    vnx02_true(in_array('Content-Type: application/vnd.fai.lead-event.v1+json', $headers, true));
    vnx02_true(in_array('Content-Length: ' . strlen($envelope->body), $headers, true));
    $signed = GatewayProtocol::signedBytes(
        'synthetic-wordpress-v1',
        '1787313600',
        '0123456789abcdef0123456789abcdef',
        $envelope->body
    );
    vnx02_true(in_array('X-FAI-Signature: ' . GatewayProtocol::signature($secret, $signed), $headers, true));
});

vnx02_test('timeout and every relevant HTTP status have deterministic bounded behavior', function (): void {
    $body = '{}';
    $secret = hex2bin(str_repeat('11', 32));
    $cases = array(
        array(400, null, DeliveryResult::TERMINAL, 'INVALID_REQUEST', null),
        array(401, null, DeliveryResult::RETRY, 'UNAUTHORIZED', null),
        array(409, null, DeliveryResult::TERMINAL, 'CONFLICT', null),
        array(429, '17', DeliveryResult::RETRY, 'RATE_LIMITED', 17),
        array(503, null, DeliveryResult::RETRY, 'TEMPORARILY_UNAVAILABLE', null),
        array(599, null, DeliveryResult::RETRY, 'TEMPORARILY_UNAVAILABLE', null),
        array(418, null, DeliveryResult::TERMINAL, 'UNEXPECTED_RESPONSE', null),
    );
    foreach ($cases as [$status, $retryAfter, $disposition, $code, $delay]) {
        $transport = new Vnx02RecordingTransport(new TransportResponse($status, '{}', $retryAfter));
        $result = (new GatewayClient($transport))->deliver(
            'https://crm.synthetic.invalid/api/integrations/website/leads/v2',
            'synthetic-wordpress-v1',
            $secret,
            $body,
            1787313600,
            '0123456789abcdef0123456789abcdef'
        );
        vnx02_same($disposition, $result->disposition);
        vnx02_same($code, $result->code);
        vnx02_same($delay, $result->suggestedDelaySeconds);
    }
    $timeout = (new GatewayClient(new Vnx02RecordingTransport(null, true)))->deliver(
        'https://crm.synthetic.invalid/api/integrations/website/leads/v2',
        'synthetic-wordpress-v1',
        $secret,
        $body,
        1787313600,
        '0123456789abcdef0123456789abcdef'
    );
    vnx02_same(DeliveryResult::RETRY, $timeout->disposition);
    vnx02_same('TEMPORARILY_UNAVAILABLE', $timeout->code);
    vnx02_same(60, RetryPolicy::nextDelay(1, 17));
    vnx02_same(300, RetryPolicy::nextDelay(2));
    vnx02_same(1800, RetryPolicy::nextDelay(3));
    vnx02_same(7200, RetryPolicy::nextDelay(4));
    vnx02_same(null, RetryPolicy::nextDelay(5));
});

vnx02_test('private key loader accepts only canonical protected files outside the web root', function (): void {
    $root = sys_get_temp_dir() . '/vnx02-' . bin2hex(random_bytes(8));
    $web = $root . '/web';
    $private = $root . '/private';
    if (!mkdir($web, 0700, true) || !mkdir($private, 0700, true)) {
        throw new RuntimeException('SYNTHETIC_TEMP_SETUP_FAILED');
    }
    $path = $private . '/key';
    $inside = $web . '/key';
    $encoded = base64_encode(hex2bin(str_repeat('44', 32)));
    file_put_contents($path, $encoded . "\n");
    file_put_contents($inside, $encoded);
    chmod($path, 0600);
    chmod($inside, 0600);
    try {
        vnx02_same(hex2bin(str_repeat('44', 32)), SecretStore::readKey($path, $web));
        vnx02_throws(ConnectorException::SECRET_UNAVAILABLE, fn () => SecretStore::readKey($inside, $web));
        file_put_contents($path, $encoded . "\n\n");
        vnx02_throws(ConnectorException::SECRET_UNAVAILABLE, fn () => SecretStore::readKey($path, $web));
        file_put_contents($path, $encoded);
        chmod($path, 0644);
        if (DIRECTORY_SEPARATOR === '/') {
            vnx02_throws(ConnectorException::SECRET_UNAVAILABLE, fn () => SecretStore::readKey($path, $web));
        }
    } finally {
        @unlink($path);
        @unlink($inside);
        @rmdir($private);
        @rmdir($web);
        @rmdir($root);
    }
});

vnx02_test('queue encryption and gateway authentication keys must be distinct', function (): void {
    $queueKey = hex2bin(str_repeat('22', 32));
    $gatewayKey = hex2bin(str_repeat('11', 32));
    SecretStore::assertDistinctKeys($queueKey, $gatewayKey);
    vnx02_throws(
        ConnectorException::SECRET_UNAVAILABLE,
        fn () => SecretStore::assertDistinctKeys($queueKey, $queueKey)
    );
});

vnx02_test('safe logging vocabulary cannot echo arbitrary exception data', function (): void {
    $private = new RuntimeException('synthetic.lead@n10.invalid /private/key payload secret');
    vnx02_same(ConnectorException::INTERNAL_FAILURE, SafeLogger::safeFailureCode($private));
    $encoded = SafeLogger::encodeForTest(array(
        'event' => 'VNX02_WORKER',
        'status' => 'FAILED',
        'code' => SafeLogger::safeFailureCode($private),
    ));
    vnx02_true(!str_contains($encoded, 'synthetic.lead@n10.invalid'));
    vnx02_true(!str_contains($encoded, '/private/key'));
    vnx02_true(!str_contains($encoded, 'payload'));
});

$failures = 0;
foreach ($tests as [$name, $test]) {
    try {
        $test();
        echo "PASS {$name}\n";
    } catch (Throwable $error) {
        $failures++;
        fwrite(STDERR, "FAIL {$name}: " . get_class($error) . "\n");
    }
}
if ($failures > 0) {
    fwrite(STDERR, "VNX02 PHP tests failed: {$failures}\n");
    exit(1);
}
echo 'VNX02 PHP tests passed: ' . count($tests) . "\n";

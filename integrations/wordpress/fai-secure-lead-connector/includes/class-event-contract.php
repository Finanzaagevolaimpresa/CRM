<?php

declare(strict_types=1);

namespace FAI\VNX02;

final class EventEnvelope
{
    /**
     * @param array<string, mixed> $event
     */
    public function __construct(
        public readonly array $event,
        public readonly string $body,
        public readonly string $businessKeyDigest,
        public readonly string $payloadHash,
        public readonly string $bodyHash,
        public readonly string $submissionContentDigest
    ) {
    }
}

final class CanonicalJson
{
    private const FLAGS = JSON_UNESCAPED_SLASHES
        | JSON_UNESCAPED_UNICODE
        | JSON_UNESCAPED_LINE_TERMINATORS
        | JSON_THROW_ON_ERROR;

    public static function encode(mixed $value): string
    {
        if ($value === null || is_string($value) || is_bool($value) || is_int($value)) {
            try {
                return json_encode($value, self::FLAGS);
            } catch (\JsonException) {
                throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
            }
        }

        if (!is_array($value)) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }

        if (array_is_list($value)) {
            $items = array();
            foreach ($value as $item) {
                $items[] = self::encode($item);
            }
            return '[' . implode(',', $items) . ']';
        }

        foreach (array_keys($value) as $key) {
            if (!is_string($key)) {
                throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
            }
        }
        ksort($value, SORT_STRING);
        $members = array();
        foreach ($value as $key => $item) {
            $members[] = self::encode($key) . ':' . self::encode($item);
        }
        return '{' . implode(',', $members) . '}';
    }
}

final class EventContract
{
    public const SCHEMA_VERSION = 'fai.lead-event.v1';
    public const EVENT_TYPE = 'LEAD_SUBMITTED';
    public const EVENT_VERSION = 1;
    public const CANONICALIZATION_VERSION = 1;
    public const MAXIMUM_BODY_BYTES = 16384;
    public const CATALOG_VERSION = '2026-07-12-v1';

    private const CONTRACT_CODE_PATTERN = '/\A[A-Z0-9][A-Z0-9_.:-]*\z/D';
    private const CONTRACT_VERSION_PATTERN = '/\A[A-Za-z0-9][A-Za-z0-9_.:-]*\z/D';
    private const UUID_V4_PATTERN = '/\A[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\z/D';
    private const SHA256_PATTERN = '/\A[0-9a-f]{64}\z/D';
    private const EMAIL_PATTERN = '/\A[^\s@]+@[^\s@]+\.[^\s@]+\z/uD';
    private const FORBIDDEN_TEXT_PATTERN = '/[\x{0000}-\x{0008}\x{000B}\x{000C}\x{000E}-\x{001F}\x{007F}-\x{009F}\x{061C}\x{200E}\x{200F}\x{202A}-\x{202E}\x{2066}-\x{2069}]/u';
    private const ECMASCRIPT_TRIM_PATTERN_START = '/\A[\x{0009}-\x{000D}\x{0020}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]+/u';
    private const ECMASCRIPT_TRIM_PATTERN_END = '/[\x{0009}-\x{000D}\x{0020}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]+\z/u';
    private const ECMASCRIPT_WHITESPACE_PATTERN = '/[\x{0009}-\x{000D}\x{0020}\x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]+/u';

    private const PAYLOAD_FIELDS = array(
        'firstName' => 1000,
        'lastName' => 1000,
        'companyName' => 1000,
        'email' => 254,
        'phone' => 100,
        'city' => 1000,
        'region' => 1000,
        'interestText' => 1000,
        'serviceInterestText' => 1000,
        'message' => 4000,
        'sourcePagePath' => 500,
        'requestedAmount' => null,
    );

    private const SERVICE_CODES = array(
        'verifica_ai_essenziale',
        'audit_ai_bancabilita',
        'pre_analisi_ai_ammissibilita',
        'consulenza_strategica_60',
        'dossier_preanalisi',
        'ottimizzazione_ai_progetto',
        'business_plan_presentazione_bancaria',
        'ottimizzazione_aziendale_ai',
        'progetti_digitali',
        'gestione_misure',
        'rendicontazione',
    );

    /**
     * @param array<int|string, mixed> $fields
     * @param array<string, mixed>     $formConfig
     */
    public static function create(
        array $fields,
        int $formId,
        int $entryId,
        array $formConfig,
        ?\DateTimeImmutable $occurredAt = null,
        ?callable $randomBytes = null
    ): EventEnvelope {
        RuntimeRequirements::assertContractRuntime();
        if ($formId < 1 || $entryId < 0) {
            throw new ConnectorException(ConnectorException::FORM_MAPPING_INVALID);
        }
        $random = $randomBytes ?? static fn (int $length): string => random_bytes($length);
        $submissionId = $entryId > 0
            ? sprintf('WPFORM:%d:ENTRY:%d', $formId, $entryId)
            : sprintf('WPFORM:%d:EPHEMERAL:%s', $formId, bin2hex(self::random($random, 16)));
        $source = array(
            'systemCode' => 'WORDPRESS',
            'formCode' => self::contractCode($formConfig['form_code'] ?? null),
            'formVersion' => self::contractVersion($formConfig['form_version'] ?? null),
            'submissionId' => self::contractVersion($submissionId, 128),
        );
        $privacy = self::privacy($fields, $formConfig['privacy'] ?? null);
        $catalogReference = self::catalogReference($formConfig['catalog_reference'] ?? null);
        $payload = self::payload(
            $fields,
            $formConfig['field_map'] ?? null,
            $formConfig['requested_amount_mode'] ?? null
        );
        $now = ($occurredAt ?? new \DateTimeImmutable('now', new \DateTimeZone('UTC')))
            ->setTimezone(new \DateTimeZone('UTC'));
        $core = array(
            'schemaVersion' => self::SCHEMA_VERSION,
            'eventType' => self::EVENT_TYPE,
            'eventVersion' => self::EVENT_VERSION,
            'eventId' => self::uuidV4(self::random($random, 16)),
            'businessCorrelationId' => self::uuidV4(self::random($random, 16)),
            'occurredAt' => $now->format('Y-m-d\TH:i:s.v\Z'),
            'source' => $source,
            'privacy' => $privacy,
            'catalogReference' => $catalogReference,
            'payload' => $payload,
        );
        return self::fromValidatedCore($core);
    }

    public static function parseAndVerify(string $body): EventEnvelope
    {
        RuntimeRequirements::assertContractRuntime();
        if ($body === '' || strlen($body) > self::MAXIMUM_BODY_BYTES) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        try {
            $event = json_decode($body, true, 32, JSON_THROW_ON_ERROR | JSON_BIGINT_AS_STRING);
        } catch (\JsonException) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        if (!is_array($event) || array_is_list($event)) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        self::assertExactKeys($event, array(
            'schemaVersion',
            'eventType',
            'eventVersion',
            'eventId',
            'businessCorrelationId',
            'occurredAt',
            'source',
            'privacy',
            'catalogReference',
            'payload',
            'idempotency',
        ));
        $idempotency = $event['idempotency'];
        if (!is_array($idempotency) || array_is_list($idempotency)) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        self::assertExactKeys($idempotency, array(
            'canonicalizationVersion', 'keyDigest', 'payloadHash',
        ));
        $suppliedKeyDigest = $idempotency['keyDigest'] ?? null;
        $suppliedPayloadHash = $idempotency['payloadHash'] ?? null;
        if (
            ($idempotency['canonicalizationVersion'] ?? null) !== self::CANONICALIZATION_VERSION
            || !is_string($suppliedKeyDigest)
            || !is_string($suppliedPayloadHash)
            || preg_match(self::SHA256_PATTERN, $suppliedKeyDigest) !== 1
            || preg_match(self::SHA256_PATTERN, $suppliedPayloadHash) !== 1
        ) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        unset($event['idempotency']);
        $validated = self::validatedParsedCore($event);
        $envelope = self::fromValidatedCore($validated);
        if (
            !hash_equals($envelope->businessKeyDigest, $suppliedKeyDigest)
            || !hash_equals($envelope->payloadHash, $suppliedPayloadHash)
            || !hash_equals($envelope->body, $body)
        ) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        return $envelope;
    }

    public static function normalizeChoice(mixed $value): string
    {
        return self::normalizedText($value, 1000, true);
    }

    /**
     * @param array<string, mixed> $core
     */
    private static function fromValidatedCore(array $core): EventEnvelope
    {
        $businessKeyDigest = hash(
            'sha256',
            "fai.lead-event.idempotency.v1\n" . CanonicalJson::encode($core['source'])
        );
        $payloadHash = hash(
            'sha256',
            "fai.lead-event.payload.v1\n" . CanonicalJson::encode($core)
        );
        $event = $core;
        $event['idempotency'] = array(
            'canonicalizationVersion' => self::CANONICALIZATION_VERSION,
            'keyDigest' => $businessKeyDigest,
            'payloadHash' => $payloadHash,
        );
        $body = CanonicalJson::encode($event);
        if (strlen($body) > self::MAXIMUM_BODY_BYTES) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_TOO_LARGE);
        }
        $submissionContentDigest = hash(
            'sha256',
            "fai.wordpress-secure-lead-connector.submission.v1\n" . CanonicalJson::encode(array(
                'source' => $core['source'],
                'privacy' => $core['privacy'],
                'catalogReference' => $core['catalogReference'],
                'payload' => $core['payload'],
            ))
        );
        return new EventEnvelope(
            $event,
            $body,
            $businessKeyDigest,
            $payloadHash,
            hash('sha256', $body),
            $submissionContentDigest
        );
    }

    /**
     * @param array<string, mixed> $core
     * @return array<string, mixed>
     */
    private static function validatedParsedCore(array $core): array
    {
        self::assertExactKeys($core, array(
            'schemaVersion',
            'eventType',
            'eventVersion',
            'eventId',
            'businessCorrelationId',
            'occurredAt',
            'source',
            'privacy',
            'catalogReference',
            'payload',
        ));
        if (
            ($core['schemaVersion'] ?? null) !== self::SCHEMA_VERSION
            || ($core['eventType'] ?? null) !== self::EVENT_TYPE
            || ($core['eventVersion'] ?? null) !== self::EVENT_VERSION
        ) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        return array(
            'schemaVersion' => self::SCHEMA_VERSION,
            'eventType' => self::EVENT_TYPE,
            'eventVersion' => self::EVENT_VERSION,
            'eventId' => self::uuid($core['eventId'] ?? null),
            'businessCorrelationId' => self::uuid($core['businessCorrelationId'] ?? null),
            'occurredAt' => self::canonicalTimestamp($core['occurredAt'] ?? null),
            'source' => self::source($core['source'] ?? null),
            'privacy' => self::parsedPrivacy($core['privacy'] ?? null),
            'catalogReference' => self::catalogReference($core['catalogReference'] ?? null),
            'payload' => self::parsedPayload($core['payload'] ?? null),
        );
    }

    private static function random(callable $randomBytes, int $length): string
    {
        $bytes = $randomBytes($length);
        if (!is_string($bytes) || strlen($bytes) !== $length) {
            throw new ConnectorException(ConnectorException::INTERNAL_FAILURE);
        }
        return $bytes;
    }

    private static function uuidV4(string $bytes): string
    {
        if (strlen($bytes) !== 16) {
            throw new ConnectorException(ConnectorException::INTERNAL_FAILURE);
        }
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        $hex = bin2hex($bytes);
        return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-'
            . substr($hex, 12, 4) . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20);
    }

    private static function uuid(mixed $value): string
    {
        $normalized = strtolower(self::normalizedText($value, 36));
        if (preg_match(self::UUID_V4_PATTERN, $normalized) !== 1) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        return $normalized;
    }

    private static function canonicalTimestamp(mixed $value): string
    {
        $timestamp = self::normalizedText($value, 24);
        if (preg_match('/\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\z/D', $timestamp) !== 1) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        $parsed = \DateTimeImmutable::createFromFormat(
            '!Y-m-d\TH:i:s.v\Z',
            $timestamp,
            new \DateTimeZone('UTC')
        );
        $errors = \DateTimeImmutable::getLastErrors();
        if (
            $parsed === false
            || (is_array($errors) && ($errors['warning_count'] !== 0 || $errors['error_count'] !== 0))
            || $parsed->format('Y-m-d\TH:i:s.v\Z') !== $timestamp
        ) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        return $timestamp;
    }

    private static function normalizedText(mixed $value, int $maximum, bool $allowEmpty = false): string
    {
        if (!is_string($value)) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        $normalized = \Normalizer::normalize($value, \Normalizer::FORM_C);
        if (!is_string($normalized)) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        $trimmed = preg_replace(self::ECMASCRIPT_TRIM_PATTERN_START, '', $normalized);
        $trimmed = is_string($trimmed)
            ? preg_replace(self::ECMASCRIPT_TRIM_PATTERN_END, '', $trimmed)
            : null;
        if (!is_string($trimmed)) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        $utf16 = mb_convert_encoding($trimmed, 'UTF-16LE', 'UTF-8');
        $length = intdiv(strlen($utf16), 2);
        if (
            (!$allowEmpty && $length === 0)
            || $length > $maximum
            || preg_match(self::FORBIDDEN_TEXT_PATTERN, $trimmed) === 1
        ) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        return $trimmed;
    }

    private static function optionalText(mixed $value, int $maximum): ?string
    {
        $normalized = self::normalizedText($value, $maximum, true);
        return $normalized === '' ? null : $normalized;
    }

    private static function contractCode(mixed $value): string
    {
        $normalized = self::normalizedText($value, 120);
        if (preg_match(self::CONTRACT_CODE_PATTERN, $normalized) !== 1) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        return $normalized;
    }

    private static function contractVersion(mixed $value, int $maximum = 80): string
    {
        $normalized = self::normalizedText($value, $maximum);
        if (preg_match(self::CONTRACT_VERSION_PATTERN, $normalized) !== 1) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        return $normalized;
    }

    /**
     * @param array<int|string, mixed> $fields
     * @param mixed                    $privacyConfig
     * @return array<string, mixed>
     */
    private static function privacy(array $fields, mixed $privacyConfig): array
    {
        if (!is_array($privacyConfig) || array_is_list($privacyConfig)) {
            throw new ConnectorException(ConnectorException::PRIVACY_MAPPING_INVALID);
        }
        self::assertExactKeys($privacyConfig, array('service', 'marketing'));
        $service = $privacyConfig['service'];
        $marketing = $privacyConfig['marketing'];
        if (!is_array($service) || !is_array($marketing)) {
            throw new ConnectorException(ConnectorException::PRIVACY_MAPPING_INVALID);
        }
        $serviceValue = self::fieldValue($fields, $service['field_id'] ?? null, true);
        $marketingValue = self::fieldValue($fields, $marketing['field_id'] ?? null, true);
        $serviceChoice = self::normalizeChoice($serviceValue);
        $marketingChoice = self::normalizeChoice($marketingValue);
        $accepted = self::normalizedChoices($service['accepted_values'] ?? null);
        $granted = self::normalizedChoices($marketing['granted_values'] ?? null);
        $denied = self::normalizedChoices($marketing['denied_values'] ?? null);
        if (!in_array($serviceChoice, $accepted, true)) {
            throw new ConnectorException(ConnectorException::PRIVACY_MAPPING_INVALID);
        }
        if (in_array($marketingChoice, $granted, true)) {
            $marketingDecision = 'GRANTED';
        } elseif (in_array($marketingChoice, $denied, true)) {
            $marketingDecision = 'DENIED';
        } else {
            throw new ConnectorException(ConnectorException::PRIVACY_MAPPING_INVALID);
        }
        return array(
            'service' => self::privacyReference($service, 'service', 'ACKNOWLEDGED'),
            'marketing' => self::privacyReference($marketing, 'marketing', $marketingDecision),
        );
    }

    /**
     * @param array<string, mixed> $config
     * @return array<string, string>
     */
    private static function privacyReference(array $config, string $kind, string $decision): array
    {
        $reference = array(
            'noticeCode' => self::contractCode($config['notice_code'] ?? null),
            'noticeVersion' => self::contractVersion($config['notice_version'] ?? null),
            'purposeCode' => self::contractCode($config['purpose_code'] ?? null),
            'legalBasisCode' => self::contractCode($config['legal_basis_code'] ?? null),
            'evidenceKind' => self::contractCode($config['evidence_kind'] ?? null),
            'decision' => $decision,
        );
        $valid = $kind === 'service'
            ? $reference['purposeCode'] === 'SERVICE_REQUEST_FOLLOW_UP'
                && $reference['legalBasisCode'] === 'PRE_CONTRACTUAL_MEASURES'
                && $reference['evidenceKind'] === 'NOTICE_ACKNOWLEDGEMENT'
                && $decision === 'ACKNOWLEDGED'
            : $reference['purposeCode'] === 'DIRECT_MARKETING'
                && $reference['legalBasisCode'] === 'CONSENT'
                && $reference['evidenceKind'] === 'CONSENT'
                && ($decision === 'GRANTED' || $decision === 'DENIED');
        if (!$valid) {
            throw new ConnectorException(ConnectorException::PRIVACY_MAPPING_INVALID);
        }
        return $reference;
    }

    /**
     * @return array<int, string>
     */
    private static function normalizedChoices(mixed $values): array
    {
        if (!is_array($values) || !array_is_list($values) || $values === array() || count($values) > 20) {
            throw new ConnectorException(ConnectorException::PRIVACY_MAPPING_INVALID);
        }
        $output = array();
        foreach ($values as $value) {
            $normalized = self::normalizeChoice($value);
            if (in_array($normalized, $output, true)) {
                throw new ConnectorException(ConnectorException::PRIVACY_MAPPING_INVALID);
            }
            $output[] = $normalized;
        }
        return $output;
    }

    /**
     * @param array<int|string, mixed> $fields
     * @param mixed                    $fieldMap
     * @return array<string, mixed>
     */
    private static function payload(array $fields, mixed $fieldMap, mixed $requestedAmountMode): array
    {
        if (!is_array($fieldMap) || array_is_list($fieldMap)) {
            throw new ConnectorException(ConnectorException::FORM_MAPPING_INVALID);
        }
        $output = array();
        foreach ($fieldMap as $name => $fieldId) {
            if (!is_string($name) || !array_key_exists($name, self::PAYLOAD_FIELDS)) {
                throw new ConnectorException(ConnectorException::FORM_MAPPING_INVALID);
            }
            $value = self::fieldValue($fields, $fieldId, false);
            if ($name === 'requestedAmount') {
                $amount = self::requestedAmount($value, $requestedAmountMode);
                if ($amount !== null) {
                    $output[$name] = $amount;
                }
                continue;
            }
            $normalized = self::optionalText($value, (int) self::PAYLOAD_FIELDS[$name]);
            if ($normalized !== null) {
                $output[$name] = $normalized;
            }
        }
        return self::normalizePayload($output);
    }

    /**
     * @param array<int|string, mixed> $fields
     */
    private static function fieldValue(array $fields, mixed $fieldId, bool $privacy): string
    {
        if (!is_int($fieldId) || $fieldId < 1 || !array_key_exists($fieldId, $fields)) {
            throw new ConnectorException(
                $privacy ? ConnectorException::PRIVACY_MAPPING_INVALID : ConnectorException::FORM_MAPPING_INVALID
            );
        }
        $field = $fields[$fieldId];
        if (!is_array($field) || !array_key_exists('value', $field) || !is_string($field['value'])) {
            throw new ConnectorException(
                $privacy ? ConnectorException::PRIVACY_MAPPING_INVALID : ConnectorException::FORM_MAPPING_INVALID
            );
        }
        return $field['value'];
    }

    /**
     * @return array{currency: string, minorUnits: int}|null
     */
    private static function requestedAmount(string $value, mixed $mode): ?array
    {
        $normalized = self::normalizedText($value, 100, true);
        if ($normalized === '') {
            return null;
        }
        if ($mode === 'EUR_MINOR_UNITS') {
            if (preg_match('/\A(?:0|[1-9]\d*)\z/D', $normalized) !== 1) {
                throw new ConnectorException(ConnectorException::FORM_MAPPING_INVALID);
            }
            $minorUnits = self::boundedInteger($normalized, '9007199254740991');
        } elseif ($mode === 'EUR_MAJOR_DECIMAL') {
            if (preg_match('/\A(0|[1-9]\d*)(?:[.,](\d{1,2}))?\z/D', $normalized, $parts) !== 1) {
                throw new ConnectorException(ConnectorException::FORM_MAPPING_INVALID);
            }
            $whole = self::boundedInteger($parts[1], '90071992547409');
            $fraction = isset($parts[2]) ? str_pad($parts[2], 2, '0') : '00';
            if ($whole === 90071992547409 && (int) $fraction > 91) {
                throw new ConnectorException(ConnectorException::FORM_MAPPING_INVALID);
            }
            $minorUnits = ($whole * 100) + (int) $fraction;
        } else {
            throw new ConnectorException(ConnectorException::FORM_MAPPING_INVALID);
        }
        return array('currency' => 'EUR', 'minorUnits' => $minorUnits);
    }

    private static function boundedInteger(string $digits, string $maximum): int
    {
        if (strlen($digits) > strlen($maximum)
            || (strlen($digits) === strlen($maximum) && strcmp($digits, $maximum) > 0)) {
            throw new ConnectorException(ConnectorException::FORM_MAPPING_INVALID);
        }
        return (int) $digits;
    }

    /**
     * @return array<string, mixed>|null
     */
    private static function catalogReference(mixed $value): ?array
    {
        if ($value === null) {
            return null;
        }
        if (!is_array($value) || array_is_list($value)) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        self::assertExactKeys($value, array('catalogVersion', 'serviceCode', 'serviceVersion'));
        if (
            ($value['catalogVersion'] ?? null) !== self::CATALOG_VERSION
            || ($value['serviceVersion'] ?? null) !== 1
            || !is_string($value['serviceCode'] ?? null)
            || !in_array($value['serviceCode'], self::SERVICE_CODES, true)
        ) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        return array(
            'catalogVersion' => self::CATALOG_VERSION,
            'serviceCode' => $value['serviceCode'],
            'serviceVersion' => 1,
        );
    }

    /**
     * @return array<string, string>
     */
    private static function source(mixed $value): array
    {
        if (!is_array($value) || array_is_list($value)) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        self::assertExactKeys($value, array('systemCode', 'formCode', 'formVersion', 'submissionId'));
        return array(
            'systemCode' => self::contractCode($value['systemCode'] ?? null),
            'formCode' => self::contractCode($value['formCode'] ?? null),
            'formVersion' => self::contractVersion($value['formVersion'] ?? null),
            'submissionId' => self::contractVersion($value['submissionId'] ?? null, 128),
        );
    }

    /**
     * @return array<string, mixed>
     */
    private static function parsedPrivacy(mixed $value): array
    {
        if (!is_array($value) || array_is_list($value)) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        self::assertExactKeys($value, array('service', 'marketing'));
        return array(
            'service' => self::parsedPrivacyReference($value['service'] ?? null, 'service'),
            'marketing' => self::parsedPrivacyReference($value['marketing'] ?? null, 'marketing'),
        );
    }

    /**
     * @return array<string, string>
     */
    private static function parsedPrivacyReference(mixed $value, string $kind): array
    {
        if (!is_array($value) || array_is_list($value)) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        self::assertExactKeys($value, array(
            'noticeCode', 'noticeVersion', 'purposeCode', 'legalBasisCode', 'evidenceKind', 'decision',
        ));
        $decision = self::contractCode($value['decision'] ?? null);
        return self::privacyReference(array(
            'notice_code' => $value['noticeCode'] ?? null,
            'notice_version' => $value['noticeVersion'] ?? null,
            'purpose_code' => $value['purposeCode'] ?? null,
            'legal_basis_code' => $value['legalBasisCode'] ?? null,
            'evidence_kind' => $value['evidenceKind'] ?? null,
        ), $kind, $decision);
    }

    /**
     * @return array<string, mixed>
     */
    private static function parsedPayload(mixed $value): array
    {
        if (!is_array($value) || array_is_list($value)) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        foreach (array_keys($value) as $key) {
            if (!is_string($key) || !array_key_exists($key, self::PAYLOAD_FIELDS)) {
                throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
            }
        }
        $normalized = array();
        foreach ($value as $name => $fieldValue) {
            if ($name === 'requestedAmount') {
                if (!is_array($fieldValue) || array_is_list($fieldValue)) {
                    throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
                }
                self::assertExactKeys($fieldValue, array('currency', 'minorUnits'));
                if (
                    ($fieldValue['currency'] ?? null) !== 'EUR'
                    || !is_int($fieldValue['minorUnits'] ?? null)
                    || $fieldValue['minorUnits'] < 0
                    || $fieldValue['minorUnits'] > 9007199254740991
                ) {
                    throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
                }
                $normalized[$name] = array('currency' => 'EUR', 'minorUnits' => $fieldValue['minorUnits']);
                continue;
            }
            $text = self::optionalText($fieldValue, (int) self::PAYLOAD_FIELDS[$name]);
            if ($text !== null) {
                $normalized[$name] = $text;
            }
        }
        return self::normalizePayload($normalized);
    }

    /**
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    private static function normalizePayload(array $payload): array
    {
        if (isset($payload['email'])) {
            $email = (string) $payload['email'];
            if (
                preg_match('/[^\x00-\x7F]/', $email) === 1
                || self::utf16Length($email) > 254
                || preg_match(self::EMAIL_PATTERN, $email) !== 1
            ) {
                throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
            }
            $payload['email'] = strtolower($email);
        }
        if (isset($payload['phone'])) {
            $phone = preg_replace(self::ECMASCRIPT_WHITESPACE_PATTERN, '', (string) $payload['phone']);
            if (!is_string($phone) || self::utf16Length($phone) > 50) {
                throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
            }
            $payload['phone'] = $phone;
        }
        if (!isset($payload['email']) && !isset($payload['phone'])) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        if (isset($payload['sourcePagePath'])) {
            $path = (string) $payload['sourcePagePath'];
            if (
                !str_starts_with($path, '/')
                || str_starts_with($path, '//')
                || preg_match('/[\x{0009}\x{000A}\x{000D}?#\\\\]/u', $path) === 1
            ) {
                throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
            }
            foreach (explode('/', $path) as $segment) {
                if (preg_match('/\A(?:\.|%2e){1,2}\z/iuD', $segment) === 1) {
                    throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
                }
            }
        }
        return $payload;
    }

    private static function utf16Length(string $value): int
    {
        return intdiv(strlen(mb_convert_encoding($value, 'UTF-16LE', 'UTF-8')), 2);
    }

    /**
     * @param array<string, mixed> $value
     * @param array<int, string>   $expected
     */
    private static function assertExactKeys(array $value, array $expected): void
    {
        $keys = array_keys($value);
        if (!array_is_list($keys) || array_filter($keys, 'is_string') !== $keys) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        sort($keys, SORT_STRING);
        sort($expected, SORT_STRING);
        if ($keys !== $expected) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
    }
}

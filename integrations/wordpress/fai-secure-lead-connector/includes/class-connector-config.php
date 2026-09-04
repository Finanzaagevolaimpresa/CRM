<?php

declare(strict_types=1);

namespace FAI\VNX02;

final class ConnectorConfig
{
    public const CONSTANT_NAME = 'FAI_VNX02_CONNECTOR_CONFIG';
    public const VERSION = 1;
    public const MAXIMUM_FORMS = 50;
    public const MAXIMUM_KEY_FILES = 4;

    /**
     * @param array<string, string>              $gatewayKeyFiles
     * @param array<int, array<string, mixed>>   $forms
     */
    private function __construct(
        public readonly bool $enabled,
        public readonly string $gatewayUrl,
        public readonly string $activeKeyId,
        public readonly array $gatewayKeyFiles,
        public readonly string $queueKeyFile,
        public readonly array $forms
    ) {
    }

    public static function load(): self
    {
        if (!defined(self::CONSTANT_NAME)) {
            return self::disabled();
        }
        return self::fromArray(constant(self::CONSTANT_NAME));
    }

    public static function fromArray(mixed $input): self
    {
        if (!is_array($input) || array_is_list($input)) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        self::assertExactKeys($input, array(
            'version',
            'enabled',
            'gateway_url',
            'active_key_id',
            'gateway_key_files',
            'queue_key_file',
            'forms',
        ));
        if (($input['version'] ?? null) !== self::VERSION || !is_bool($input['enabled'] ?? null)) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        if ($input['enabled'] === false) {
            return self::disabled();
        }

        RuntimeRequirements::assertContractRuntime();
        $gatewayUrl = self::gatewayUrl($input['gateway_url'] ?? null);
        $activeKeyId = self::keyId($input['active_key_id'] ?? null);
        $gatewayKeyFiles = self::keyFiles($input['gateway_key_files'] ?? null);
        if (!array_key_exists($activeKeyId, $gatewayKeyFiles)) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        $queueKeyFile = self::absolutePath($input['queue_key_file'] ?? null);
        if (in_array($queueKeyFile, $gatewayKeyFiles, true)) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        $forms = self::forms($input['forms'] ?? null);
        return new self(true, $gatewayUrl, $activeKeyId, $gatewayKeyFiles, $queueKeyFile, $forms);
    }

    public function form(int $formId): ?array
    {
        return $this->forms[$formId] ?? null;
    }

    public function gatewayKeyFile(string $keyId): string
    {
        if (!array_key_exists($keyId, $this->gatewayKeyFiles)) {
            throw new ConnectorException(ConnectorException::SECRET_UNAVAILABLE);
        }
        return $this->gatewayKeyFiles[$keyId];
    }

    private static function disabled(): self
    {
        return new self(false, '', '', array(), '', array());
    }

    private static function gatewayUrl(mixed $value): string
    {
        if (!is_string($value) || strlen($value) > 2048 || filter_var($value, FILTER_VALIDATE_URL) === false) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        $parts = parse_url($value);
        if (
            !is_array($parts)
            || ($parts['scheme'] ?? null) !== 'https'
            || !is_string($parts['host'] ?? null)
            || $parts['host'] === ''
            || ($parts['path'] ?? null) !== '/api/integrations/website/leads/v2'
            || array_key_exists('user', $parts)
            || array_key_exists('pass', $parts)
            || array_key_exists('query', $parts)
            || array_key_exists('fragment', $parts)
        ) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        return $value;
    }

    private static function keyId(mixed $value): string
    {
        if (!is_string($value) || preg_match('/\A[A-Za-z0-9][A-Za-z0-9._:-]{2,79}\z/D', $value) !== 1) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        return $value;
    }

    /**
     * @return array<string, string>
     */
    private static function keyFiles(mixed $value): array
    {
        if (
            !is_array($value)
            || array_is_list($value)
            || count($value) < 1
            || count($value) > self::MAXIMUM_KEY_FILES
        ) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        $output = array();
        foreach ($value as $keyId => $path) {
            if (!is_string($keyId)) {
                throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
            }
            $output[self::keyId($keyId)] = self::absolutePath($path);
        }
        if (count(array_unique($output, SORT_STRING)) !== count($output)) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        return $output;
    }

    private static function absolutePath(mixed $value): string
    {
        if (
            !is_string($value)
            || $value === ''
            || strlen($value) > 4096
            || str_contains($value, "\0")
            || preg_match('/[\r\n]/', $value) === 1
            || !(str_starts_with($value, '/') || preg_match('/\A[A-Za-z]:[\\\\\/]/D', $value) === 1)
        ) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        return $value;
    }

    /**
     * @return array<int, array<string, mixed>>
     */
    private static function forms(mixed $value): array
    {
        if (
            !is_array($value)
            || array_is_list($value)
            || count($value) < 1
            || count($value) > self::MAXIMUM_FORMS
        ) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        $output = array();
        $formIdentities = array();
        foreach ($value as $formId => $formConfig) {
            if (!is_int($formId) || $formId < 1 || !is_array($formConfig) || array_is_list($formConfig)) {
                throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
            }
            $validated = self::formConfig($formConfig);
            $identity = $validated['form_code'] . "\n" . $validated['form_version'];
            if (isset($formIdentities[$identity])) {
                throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
            }
            $formIdentities[$identity] = true;
            $output[$formId] = $validated;
        }
        return $output;
    }

    /**
     * @param array<string, mixed> $value
     * @return array<string, mixed>
     */
    private static function formConfig(array $value): array
    {
        self::assertExactKeys($value, array(
            'form_code',
            'form_version',
            'field_map',
            'requested_amount_mode',
            'privacy',
            'catalog_reference',
        ));
        $formCode = self::contractCode($value['form_code'] ?? null);
        $formVersion = self::contractVersion($value['form_version'] ?? null);
        $fieldMap = self::fieldMap($value['field_map'] ?? null);
        $requestedAmountMode = $value['requested_amount_mode'] ?? null;
        if (array_key_exists('requestedAmount', $fieldMap)) {
            if (!in_array($requestedAmountMode, array('EUR_MAJOR_DECIMAL', 'EUR_MINOR_UNITS'), true)) {
                throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
            }
        } elseif ($requestedAmountMode !== null) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        $privacy = self::privacy($value['privacy'] ?? null);
        $allFieldIds = array_merge(
            array_values($fieldMap),
            array($privacy['service']['field_id'], $privacy['marketing']['field_id'])
        );
        if (count(array_unique($allFieldIds, SORT_REGULAR)) !== count($allFieldIds)) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        $catalogReference = self::catalogReference($value['catalog_reference'] ?? null);
        return array(
            'form_code' => $formCode,
            'form_version' => $formVersion,
            'field_map' => $fieldMap,
            'requested_amount_mode' => $requestedAmountMode,
            'privacy' => $privacy,
            'catalog_reference' => $catalogReference,
        );
    }

    /**
     * @return array<string, int>
     */
    private static function fieldMap(mixed $value): array
    {
        $allowed = array(
            'firstName',
            'lastName',
            'companyName',
            'email',
            'phone',
            'city',
            'region',
            'interestText',
            'serviceInterestText',
            'message',
            'sourcePagePath',
            'requestedAmount',
        );
        if (!is_array($value) || array_is_list($value) || $value === array()) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        $output = array();
        foreach ($value as $field => $fieldId) {
            if (!is_string($field) || !in_array($field, $allowed, true) || !is_int($fieldId) || $fieldId < 1) {
                throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
            }
            $output[$field] = $fieldId;
        }
        if (!array_key_exists('email', $output) && !array_key_exists('phone', $output)) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        if (count(array_unique(array_values($output), SORT_REGULAR)) !== count($output)) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        return $output;
    }

    /**
     * @return array<string, array<string, mixed>>
     */
    private static function privacy(mixed $value): array
    {
        if (!is_array($value) || array_is_list($value)) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        self::assertExactKeys($value, array('service', 'marketing'));
        $service = self::privacyBranch($value['service'] ?? null, 'service');
        $marketing = self::privacyBranch($value['marketing'] ?? null, 'marketing');
        if ($service['field_id'] === $marketing['field_id']) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        return array('service' => $service, 'marketing' => $marketing);
    }

    /**
     * @return array<string, mixed>
     */
    private static function privacyBranch(mixed $value, string $kind): array
    {
        if (!is_array($value) || array_is_list($value)) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        $choiceKeys = $kind === 'service'
            ? array('accepted_values')
            : array('granted_values', 'denied_values');
        self::assertExactKeys($value, array_merge(array(
            'field_id',
            'notice_code',
            'notice_version',
            'purpose_code',
            'legal_basis_code',
            'evidence_kind',
        ), $choiceKeys));
        if (!is_int($value['field_id'] ?? null) || $value['field_id'] < 1) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        $output = array(
            'field_id' => $value['field_id'],
            'notice_code' => self::contractCode($value['notice_code'] ?? null),
            'notice_version' => self::contractVersion($value['notice_version'] ?? null),
            'purpose_code' => self::contractCode($value['purpose_code'] ?? null),
            'legal_basis_code' => self::contractCode($value['legal_basis_code'] ?? null),
            'evidence_kind' => self::contractCode($value['evidence_kind'] ?? null),
        );
        if ($kind === 'service') {
            $output['accepted_values'] = self::choices($value['accepted_values'] ?? null);
            if (in_array('', $output['accepted_values'], true)) {
                throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
            }
            $validSemantics = $output['purpose_code'] === 'SERVICE_REQUEST_FOLLOW_UP'
                && $output['legal_basis_code'] === 'PRE_CONTRACTUAL_MEASURES'
                && $output['evidence_kind'] === 'NOTICE_ACKNOWLEDGEMENT';
        } else {
            $output['granted_values'] = self::choices($value['granted_values'] ?? null);
            $output['denied_values'] = self::choices($value['denied_values'] ?? null);
            if (in_array('', $output['granted_values'], true)
                || array_intersect($output['granted_values'], $output['denied_values']) !== array()) {
                throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
            }
            $validSemantics = $output['purpose_code'] === 'DIRECT_MARKETING'
                && $output['legal_basis_code'] === 'CONSENT'
                && $output['evidence_kind'] === 'CONSENT';
        }
        if (!$validSemantics) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        return $output;
    }

    /**
     * @return array<int, string>
     */
    private static function choices(mixed $value): array
    {
        if (!is_array($value) || !array_is_list($value) || $value === array() || count($value) > 20) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        $output = array();
        foreach ($value as $choice) {
            try {
                $normalized = EventContract::normalizeChoice($choice);
            } catch (ConnectorException) {
                throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
            }
            if (in_array($normalized, $output, true)) {
                throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
            }
            $output[] = $normalized;
        }
        return $output;
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
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        self::assertExactKeys($value, array('catalogVersion', 'serviceCode', 'serviceVersion'));
        $allowedServices = array(
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
        if (
            ($value['catalogVersion'] ?? null) !== EventContract::CATALOG_VERSION
            || ($value['serviceVersion'] ?? null) !== 1
            || !is_string($value['serviceCode'] ?? null)
            || !in_array($value['serviceCode'], $allowedServices, true)
        ) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        return array(
            'catalogVersion' => EventContract::CATALOG_VERSION,
            'serviceCode' => $value['serviceCode'],
            'serviceVersion' => 1,
        );
    }

    private static function contractCode(mixed $value): string
    {
        if (
            !is_string($value)
            || strlen($value) < 1
            || strlen($value) > 120
            || preg_match('/\A[A-Z0-9][A-Z0-9_.:-]*\z/D', $value) !== 1
        ) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        return $value;
    }

    private static function contractVersion(mixed $value): string
    {
        if (
            !is_string($value)
            || strlen($value) < 1
            || strlen($value) > 80
            || preg_match('/\A[A-Za-z0-9][A-Za-z0-9_.:-]*\z/D', $value) !== 1
        ) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
        return $value;
    }

    /**
     * @param array<string, mixed> $value
     * @param array<int, string>   $expected
     */
    private static function assertExactKeys(array $value, array $expected): void
    {
        $keys = array_keys($value);
        foreach ($keys as $key) {
            if (!is_string($key)) {
                throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
            }
        }
        sort($keys, SORT_STRING);
        sort($expected, SORT_STRING);
        if ($keys !== $expected) {
            throw new ConnectorException(ConnectorException::CONFIGURATION_INVALID);
        }
    }
}

<?php

declare(strict_types=1);

namespace FAI\VNX02;

final class ConnectorException extends \RuntimeException
{
    public const CONFIGURATION_INVALID = 'VNX02_CONFIGURATION_INVALID';
    public const RUNTIME_UNAVAILABLE = 'VNX02_RUNTIME_UNAVAILABLE';
    public const SECRET_UNAVAILABLE = 'VNX02_SECRET_UNAVAILABLE';
    public const FORM_MAPPING_INVALID = 'VNX02_FORM_MAPPING_INVALID';
    public const PRIVACY_MAPPING_INVALID = 'VNX02_PRIVACY_MAPPING_INVALID';
    public const LEAD_EVENT_INVALID = 'VNX02_LEAD_EVENT_INVALID';
    public const LEAD_EVENT_TOO_LARGE = 'VNX02_LEAD_EVENT_TOO_LARGE';
    public const QUEUE_UNAVAILABLE = 'VNX02_QUEUE_UNAVAILABLE';
    public const QUEUE_INTEGRITY_FAILURE = 'VNX02_QUEUE_INTEGRITY_FAILURE';
    public const IDEMPOTENCY_CONFLICT = 'VNX02_IDEMPOTENCY_CONFLICT';
    public const LEASE_STALE = 'VNX02_LEASE_STALE';
    public const TRANSPORT_UNAVAILABLE = 'VNX02_TRANSPORT_UNAVAILABLE';
    public const INTERNAL_FAILURE = 'VNX02_INTERNAL_FAILURE';

    private const SAFE_CODES = array(
        self::CONFIGURATION_INVALID,
        self::RUNTIME_UNAVAILABLE,
        self::SECRET_UNAVAILABLE,
        self::FORM_MAPPING_INVALID,
        self::PRIVACY_MAPPING_INVALID,
        self::LEAD_EVENT_INVALID,
        self::LEAD_EVENT_TOO_LARGE,
        self::QUEUE_UNAVAILABLE,
        self::QUEUE_INTEGRITY_FAILURE,
        self::IDEMPOTENCY_CONFLICT,
        self::LEASE_STALE,
        self::TRANSPORT_UNAVAILABLE,
        self::INTERNAL_FAILURE,
    );

    public readonly string $safeCode;

    public function __construct(string $safeCode)
    {
        $this->safeCode = in_array($safeCode, self::SAFE_CODES, true)
            ? $safeCode
            : self::INTERNAL_FAILURE;
        parent::__construct($this->safeCode);
    }

    public static function safeCode(\Throwable $error): string
    {
        return $error instanceof self ? $error->safeCode : self::INTERNAL_FAILURE;
    }
}

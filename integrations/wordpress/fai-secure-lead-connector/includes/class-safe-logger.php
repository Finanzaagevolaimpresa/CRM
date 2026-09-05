<?php

declare(strict_types=1);

namespace FAI\VNX02;

final class SafeLogger
{
    private const SAFE_FAILURE_CODES = array(
        ConnectorException::CONFIGURATION_INVALID,
        ConnectorException::RUNTIME_UNAVAILABLE,
        ConnectorException::SECRET_UNAVAILABLE,
        ConnectorException::FORM_MAPPING_INVALID,
        ConnectorException::PRIVACY_MAPPING_INVALID,
        ConnectorException::LEAD_EVENT_INVALID,
        ConnectorException::LEAD_EVENT_TOO_LARGE,
        ConnectorException::QUEUE_UNAVAILABLE,
        ConnectorException::QUEUE_INTEGRITY_FAILURE,
        ConnectorException::IDEMPOTENCY_CONFLICT,
        ConnectorException::LEASE_STALE,
        ConnectorException::TRANSPORT_UNAVAILABLE,
        ConnectorException::INTERNAL_FAILURE,
    );

    public static function captureFailure(\Throwable $error): void
    {
        self::write(array(
            'event' => 'VNX02_CAPTURE',
            'status' => 'FAILED',
            'code' => self::safeFailureCode($error),
        ));
    }

    public static function workerFailure(\Throwable $error): void
    {
        self::write(array(
            'event' => 'VNX02_WORKER',
            'status' => 'FAILED',
            'code' => self::safeFailureCode($error),
        ));
    }

    public static function scheduleFailure(): void
    {
        self::write(array(
            'event' => 'VNX02_SCHEDULE',
            'status' => 'FAILED',
            'code' => 'VNX02_SCHEDULE_UNAVAILABLE',
        ));
    }

    public static function workerSummary(WorkerSummary $summary): void
    {
        self::write(array(
            'event' => 'VNX02_WORKER',
            'status' => 'COMPLETED',
            'claimed' => self::counter($summary->claimed),
            'delivered' => self::counter($summary->delivered),
            'retried' => self::counter($summary->retried),
            'terminal' => self::counter($summary->terminal),
            'exhausted' => self::counter($summary->exhausted),
        ));
    }

    public static function safeFailureCode(\Throwable $error): string
    {
        $code = ConnectorException::safeCode($error);
        return in_array($code, self::SAFE_FAILURE_CODES, true)
            ? $code
            : ConnectorException::INTERNAL_FAILURE;
    }

    /**
     * @param array<string, int|string> $record
     */
    public static function encodeForTest(array $record): string
    {
        $allowedKeys = array(
            'event', 'status', 'code', 'claimed', 'delivered', 'retried', 'terminal', 'exhausted',
        );
        foreach ($record as $key => $value) {
            if (!in_array($key, $allowedKeys, true) || (!is_string($value) && !is_int($value))) {
                throw new ConnectorException(ConnectorException::INTERNAL_FAILURE);
            }
        }
        try {
            return json_encode($record, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            throw new ConnectorException(ConnectorException::INTERNAL_FAILURE);
        }
    }

    /**
     * @param array<string, int|string> $record
     */
    private static function write(array $record): void
    {
        error_log('[FAI VNX02] ' . self::encodeForTest($record));
    }

    private static function counter(int $value): int
    {
        return max(0, min(QueueStore::MAXIMUM_BATCH_SIZE, $value));
    }
}

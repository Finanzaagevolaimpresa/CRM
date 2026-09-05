<?php

declare(strict_types=1);

namespace FAI\VNX02;

final class TransportResponse
{
    public function __construct(
        public readonly int $status,
        public readonly string $body,
        public readonly ?string $retryAfter
    ) {
    }
}

interface GatewayTransport
{
    /**
     * @param array<int, string> $headers
     */
    public function post(string $url, array $headers, string $body, int $timeoutMilliseconds): TransportResponse;
}

final class CurlGatewayTransport implements GatewayTransport
{
    private const MAXIMUM_RESPONSE_BYTES = 512;

    public function post(string $url, array $headers, string $body, int $timeoutMilliseconds): TransportResponse
    {
        RuntimeRequirements::assertTransportRuntime();
        $handle = @curl_init($url);
        if ($handle === false) {
            throw new ConnectorException(ConnectorException::TRANSPORT_UNAVAILABLE);
        }
        $responseBody = '';
        $retryAfter = null;
        $headerCallback = static function (mixed $unused, string $line) use (&$retryAfter): int {
            if (strlen($line) <= 1024 && stripos($line, 'Retry-After:') === 0) {
                $candidate = trim(substr($line, strlen('Retry-After:')));
                $retryAfter = strlen($candidate) <= 3 ? $candidate : null;
            }
            return strlen($line);
        };
        $writeCallback = static function (mixed $unused, string $chunk) use (&$responseBody): int {
            if (strlen($responseBody) + strlen($chunk) > self::MAXIMUM_RESPONSE_BYTES) {
                return 0;
            }
            $responseBody .= $chunk;
            return strlen($chunk);
        };
        $options = array(
            CURLOPT_CUSTOMREQUEST => 'POST',
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_HEADER => false,
            CURLOPT_HEADERFUNCTION => $headerCallback,
            CURLOPT_WRITEFUNCTION => $writeCallback,
            CURLOPT_CONNECTTIMEOUT_MS => min(2000, $timeoutMilliseconds),
            CURLOPT_TIMEOUT_MS => $timeoutMilliseconds,
            CURLOPT_NOSIGNAL => true,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_MAXREDIRS => 0,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        );
        try {
            if (!@curl_setopt_array($handle, $options) || @curl_exec($handle) === false) {
                throw new ConnectorException(ConnectorException::TRANSPORT_UNAVAILABLE);
            }
            $status = (int) @curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
        } finally {
            @curl_close($handle);
        }
        return new TransportResponse($status, $responseBody, $retryAfter);
    }
}

final class DeliveryResult
{
    public const DELIVERED = 'DELIVERED';
    public const RETRY = 'RETRY';
    public const TERMINAL = 'TERMINAL';

    public function __construct(
        public readonly string $disposition,
        public readonly string $code,
        public readonly ?int $suggestedDelaySeconds = null
    ) {
    }
}

final class GatewayProtocol
{
    public const PATH = '/api/integrations/website/leads/v2';
    public const CONTENT_TYPE = 'application/vnd.fai.lead-event.v1+json';
    public const REQUEST_DOMAIN = 'fai.secure-lead-gateway.request.v1';
    public const TIMEOUT_MILLISECONDS = 4000;

    public static function signedBytes(
        string $keyId,
        string $timestamp,
        string $nonce,
        string $rawBody
    ): string {
        if (
            preg_match('/\A[A-Za-z0-9][A-Za-z0-9._:-]{2,79}\z/D', $keyId) !== 1
            || preg_match('/\A\d{10}\z/D', $timestamp) !== 1
            || preg_match('/\A[0-9a-f]{32}\z/D', $nonce) !== 1
            || strlen($rawBody) > EventContract::MAXIMUM_BODY_BYTES
        ) {
            throw new ConnectorException(ConnectorException::LEAD_EVENT_INVALID);
        }
        return implode("\n", array(
            self::REQUEST_DOMAIN,
            'POST',
            self::PATH,
            self::CONTENT_TYPE,
            $keyId,
            $timestamp,
            $nonce,
            (string) strlen($rawBody),
            '',
        )) . $rawBody;
    }

    public static function signature(string $secret, string $signedBytes): string
    {
        if (strlen($secret) !== 32) {
            throw new ConnectorException(ConnectorException::SECRET_UNAVAILABLE);
        }
        return 'v1=' . hash_hmac('sha256', $signedBytes, $secret);
    }
}

final class GatewayClient
{
    public function __construct(private readonly GatewayTransport $transport)
    {
    }

    public function deliver(
        string $url,
        string $keyId,
        string $secret,
        string $rawBody,
        ?int $timestampSeconds = null,
        ?string $nonce = null
    ): DeliveryResult {
        $timestamp = (string) ($timestampSeconds ?? time());
        $requestNonce = $nonce ?? bin2hex(random_bytes(16));
        $signedBytes = GatewayProtocol::signedBytes($keyId, $timestamp, $requestNonce, $rawBody);
        $signature = GatewayProtocol::signature($secret, $signedBytes);
        $headers = array(
            'Accept: application/json',
            'Content-Type: ' . GatewayProtocol::CONTENT_TYPE,
            'Content-Length: ' . strlen($rawBody),
            'X-FAI-Key-Id: ' . $keyId,
            'X-FAI-Timestamp: ' . $timestamp,
            'X-FAI-Nonce: ' . $requestNonce,
            'X-FAI-Signature: ' . $signature,
            'Expect:',
        );
        try {
            $response = $this->transport->post(
                $url,
                $headers,
                $rawBody,
                GatewayProtocol::TIMEOUT_MILLISECONDS
            );
        } catch (\Throwable) {
            return new DeliveryResult(
                DeliveryResult::RETRY,
                'TEMPORARILY_UNAVAILABLE'
            );
        }
        return self::classify($response);
    }

    private static function classify(TransportResponse $response): DeliveryResult
    {
        if ($response->status === 202) {
            try {
                $decoded = json_decode($response->body, true, 4, JSON_THROW_ON_ERROR);
            } catch (\JsonException) {
                $decoded = null;
            }
            if (
                is_array($decoded)
                && !array_is_list($decoded)
                && count($decoded) === 2
                && ($decoded['ok'] ?? null) === true
                && is_string($decoded['receipt'] ?? null)
                && preg_match('/\Aslg2_[0-9a-f]{32}\z/D', $decoded['receipt']) === 1
            ) {
                return new DeliveryResult(DeliveryResult::DELIVERED, 'DELIVERED');
            }
            return new DeliveryResult(DeliveryResult::RETRY, 'TEMPORARILY_UNAVAILABLE');
        }
        if ($response->status === 400 || $response->status === 413) {
            return new DeliveryResult(DeliveryResult::TERMINAL, 'INVALID_REQUEST');
        }
        if ($response->status === 409) {
            return new DeliveryResult(DeliveryResult::TERMINAL, 'CONFLICT');
        }
        if ($response->status === 401) {
            return new DeliveryResult(DeliveryResult::RETRY, 'UNAUTHORIZED');
        }
        if ($response->status === 429) {
            $retryAfter = self::retryAfter($response->retryAfter);
            return new DeliveryResult(DeliveryResult::RETRY, 'RATE_LIMITED', $retryAfter);
        }
        if (
            $response->status === 408
            || $response->status === 503
            || ($response->status >= 500 && $response->status <= 599)
        ) {
            return new DeliveryResult(DeliveryResult::RETRY, 'TEMPORARILY_UNAVAILABLE');
        }
        return new DeliveryResult(DeliveryResult::TERMINAL, 'UNEXPECTED_RESPONSE');
    }

    private static function retryAfter(?string $value): ?int
    {
        if (!is_string($value) || preg_match('/\A(?:[1-9]|[1-5]\d|60)\z/D', $value) !== 1) {
            return null;
        }
        return (int) $value;
    }
}

final class RetryPolicy
{
    public const MAXIMUM_ATTEMPTS = 5;
    private const BACKOFF_SECONDS = array(60, 300, 1800, 7200);

    public static function nextDelay(int $attempt, ?int $suggested = null): ?int
    {
        if ($attempt < 1 || $attempt >= self::MAXIMUM_ATTEMPTS) {
            return null;
        }
        $base = self::BACKOFF_SECONDS[$attempt - 1];
        if ($suggested !== null && $suggested >= 1 && $suggested <= 60) {
            return max($base, $suggested);
        }
        return $base;
    }
}

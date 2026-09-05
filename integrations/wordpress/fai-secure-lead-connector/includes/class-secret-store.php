<?php

declare(strict_types=1);

namespace FAI\VNX02;

final class SecretStore
{
    private const MAXIMUM_FILE_BYTES = 64;

    public static function readKey(string $path, string $documentRoot): string
    {
        if ($path === '' || is_link($path)) {
            throw new ConnectorException(ConnectorException::SECRET_UNAVAILABLE);
        }
        $realPath = realpath($path);
        $realRoot = realpath($documentRoot);
        if (!is_string($realPath) || !is_string($realRoot) || self::isWithin($realPath, $realRoot)) {
            throw new ConnectorException(ConnectorException::SECRET_UNAVAILABLE);
        }

        $before = @lstat($realPath);
        $handle = @fopen($realPath, 'rb');
        if (!is_array($before) || !is_resource($handle)) {
            throw new ConnectorException(ConnectorException::SECRET_UNAVAILABLE);
        }
        try {
            if (!@flock($handle, LOCK_SH)) {
                throw new ConnectorException(ConnectorException::SECRET_UNAVAILABLE);
            }
            $opened = @fstat($handle);
            $content = @stream_get_contents($handle, self::MAXIMUM_FILE_BYTES + 1);
            $after = @fstat($handle);
            if (
                !is_array($opened)
                || !is_array($after)
                || !is_string($content)
                || strlen($content) > self::MAXIMUM_FILE_BYTES
                || !self::sameFile($before, $opened)
                || !self::sameFile($opened, $after)
                || (($opened['mode'] ?? 0) & 0170000) !== 0100000
            ) {
                throw new ConnectorException(ConnectorException::SECRET_UNAVAILABLE);
            }
            if (DIRECTORY_SEPARATOR === '/' && (($opened['mode'] ?? 0) & 0077) !== 0) {
                throw new ConnectorException(ConnectorException::SECRET_UNAVAILABLE);
            }
        } finally {
            @flock($handle, LOCK_UN);
            @fclose($handle);
        }

        if (str_ends_with($content, "\n")) {
            $content = substr($content, 0, -1);
        }
        if (preg_match('/\A[A-Za-z0-9+\/]{43}=\z/D', $content) !== 1) {
            throw new ConnectorException(ConnectorException::SECRET_UNAVAILABLE);
        }
        $key = base64_decode($content, true);
        if (!is_string($key) || strlen($key) !== 32 || !hash_equals(base64_encode($key), $content)) {
            if (is_string($key)) {
                sodium_memzero($key);
            }
            sodium_memzero($content);
            throw new ConnectorException(ConnectorException::SECRET_UNAVAILABLE);
        }
        sodium_memzero($content);
        return $key;
    }

    public static function assertDistinctKeys(string $queueKey, string $gatewayKey): void
    {
        if (
            strlen($queueKey) !== 32
            || strlen($gatewayKey) !== 32
            || hash_equals($queueKey, $gatewayKey)
        ) {
            throw new ConnectorException(ConnectorException::SECRET_UNAVAILABLE);
        }
    }

    private static function isWithin(string $path, string $root): bool
    {
        $separator = DIRECTORY_SEPARATOR;
        $normalizedPath = rtrim(str_replace(array('/', '\\'), $separator, $path), $separator);
        $normalizedRoot = rtrim(str_replace(array('/', '\\'), $separator, $root), $separator);
        $prefix = $normalizedRoot . $separator;
        if (DIRECTORY_SEPARATOR === '\\') {
            return strncasecmp($normalizedPath, $prefix, strlen($prefix)) === 0
                || strcasecmp($normalizedPath, $normalizedRoot) === 0;
        }
        return strncmp($normalizedPath, $prefix, strlen($prefix)) === 0
            || $normalizedPath === $normalizedRoot;
    }

    /**
     * @param array<string|int, mixed> $first
     * @param array<string|int, mixed> $second
     */
    private static function sameFile(array $first, array $second): bool
    {
        return ($first['dev'] ?? null) === ($second['dev'] ?? null)
            && ($first['ino'] ?? null) === ($second['ino'] ?? null)
            && ($first['size'] ?? null) === ($second['size'] ?? null)
            && ($first['mode'] ?? null) === ($second['mode'] ?? null);
    }
}

final class QueueCipher
{
    private const DOMAIN = 'fai.wordpress-secure-lead-connector.queue-key.v1';
    private const RECORD_DOMAIN = 'fai.wordpress-secure-lead-connector.queue-record.v1';

    public static function encrypt(
        string $body,
        string $businessKeyDigest,
        string $bodyHash,
        string $gatewayKeyId,
        string $queueSecret,
        ?callable $randomBytes = null
    ): string {
        RuntimeRequirements::assertContractRuntime();
        self::assertMetadata($businessKeyDigest, $bodyHash, $gatewayKeyId, $queueSecret);
        if (
            $body === ''
            || strlen($body) > EventContract::MAXIMUM_BODY_BYTES
            || !hash_equals(hash('sha256', $body), $bodyHash)
        ) {
            throw new ConnectorException(ConnectorException::QUEUE_INTEGRITY_FAILURE);
        }
        $random = $randomBytes ?? static fn (int $length): string => random_bytes($length);
        $nonce = $random(SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES);
        if (!is_string($nonce) || strlen($nonce) !== SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES) {
            throw new ConnectorException(ConnectorException::INTERNAL_FAILURE);
        }
        $key = hash_hmac('sha256', self::DOMAIN, $queueSecret, true);
        try {
            $ciphertext = sodium_crypto_aead_xchacha20poly1305_ietf_encrypt(
                $body,
                self::associatedData($businessKeyDigest, $bodyHash, $gatewayKeyId),
                $nonce,
                $key
            );
            return base64_encode($nonce . $ciphertext);
        } finally {
            sodium_memzero($key);
        }
    }

    public static function decrypt(
        string $encoded,
        string $businessKeyDigest,
        string $bodyHash,
        string $gatewayKeyId,
        string $queueSecret
    ): string {
        RuntimeRequirements::assertContractRuntime();
        self::assertMetadata($businessKeyDigest, $bodyHash, $gatewayKeyId, $queueSecret);
        if ($encoded === '' || strlen($encoded) > 32768) {
            throw new ConnectorException(ConnectorException::QUEUE_INTEGRITY_FAILURE);
        }
        $packed = base64_decode($encoded, true);
        if (
            !is_string($packed)
            || !hash_equals(base64_encode($packed), $encoded)
            || strlen($packed) <= SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES
                + SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_ABYTES
        ) {
            throw new ConnectorException(ConnectorException::QUEUE_INTEGRITY_FAILURE);
        }
        $nonce = substr($packed, 0, SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES);
        $ciphertext = substr($packed, SODIUM_CRYPTO_AEAD_XCHACHA20POLY1305_IETF_NPUBBYTES);
        $key = hash_hmac('sha256', self::DOMAIN, $queueSecret, true);
        try {
            $body = sodium_crypto_aead_xchacha20poly1305_ietf_decrypt(
                $ciphertext,
                self::associatedData($businessKeyDigest, $bodyHash, $gatewayKeyId),
                $nonce,
                $key
            );
        } finally {
            sodium_memzero($key);
        }
        if (!is_string($body) || !hash_equals(hash('sha256', $body), $bodyHash)) {
            throw new ConnectorException(ConnectorException::QUEUE_INTEGRITY_FAILURE);
        }
        return $body;
    }

    private static function associatedData(
        string $businessKeyDigest,
        string $bodyHash,
        string $gatewayKeyId
    ): string {
        return self::RECORD_DOMAIN . "\n" . $businessKeyDigest . "\n" . $bodyHash . "\n" . $gatewayKeyId;
    }

    private static function assertMetadata(
        string $businessKeyDigest,
        string $bodyHash,
        string $gatewayKeyId,
        string $queueSecret
    ): void {
        if (
            preg_match('/\A[0-9a-f]{64}\z/D', $businessKeyDigest) !== 1
            || preg_match('/\A[0-9a-f]{64}\z/D', $bodyHash) !== 1
            || preg_match('/\A[A-Za-z0-9][A-Za-z0-9._:-]{2,79}\z/D', $gatewayKeyId) !== 1
            || strlen($queueSecret) !== 32
        ) {
            throw new ConnectorException(ConnectorException::QUEUE_INTEGRITY_FAILURE);
        }
    }
}

<?php

declare(strict_types=1);

namespace FAI\VNX02;

final class RuntimeRequirements
{
    public static function assertContractRuntime(): void
    {
        if (
            PHP_VERSION_ID < 80100
            || PHP_INT_SIZE < 8
            || !class_exists('Normalizer')
            || !function_exists('mb_convert_encoding')
            || !function_exists('mb_strtolower')
            || !extension_loaded('mysqli')
            || !function_exists('sodium_crypto_aead_xchacha20poly1305_ietf_encrypt')
            || !function_exists('json_encode')
        ) {
            throw new ConnectorException(ConnectorException::RUNTIME_UNAVAILABLE);
        }
    }

    public static function assertTransportRuntime(): void
    {
        if (!function_exists('curl_init')) {
            throw new ConnectorException(ConnectorException::RUNTIME_UNAVAILABLE);
        }
    }
}

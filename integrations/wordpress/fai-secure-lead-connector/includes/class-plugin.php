<?php

declare(strict_types=1);

namespace FAI\VNX02;

final class Plugin
{
    public const VERSION = '1.0.0';
    public const CRON_HOOK = 'fai_vnx02_secure_lead_queue';

    public static function register(string $pluginFile): void
    {
        register_activation_hook($pluginFile, array(self::class, 'activate'));
        register_deactivation_hook($pluginFile, array(self::class, 'deactivate'));
        add_action('init', array(self::class, 'recoverQueue'));
        add_action('wpforms_process_complete', array(self::class, 'captureSubmission'), 100, 4);
        add_action(self::CRON_HOOK, array(self::class, 'runWorker'));
    }

    public static function activate(): void
    {
        RuntimeRequirements::assertContractRuntime();
        $queue = self::queue();
        $queue->install();
        self::recoverQueue();
    }

    public static function deactivate(): void
    {
        wp_clear_scheduled_hook(self::CRON_HOOK);
    }

    /** Restore a lost wake-up without sending, claiming or resetting queued work. */
    public static function recoverQueue(): void
    {
        try {
            $config = ConnectorConfig::load();
            if (!$config->enabled || is_int(wp_next_scheduled(self::CRON_HOOK))) {
                return;
            }
            $queue = self::queue();
            if ($queue->isReady() && $queue->hasOutstanding()) {
                self::schedule($queue->nextDelaySeconds());
            }
        } catch (\Throwable $error) {
            SafeLogger::workerFailure($error);
        }
    }

    /**
     * @param array<int|string, mixed> $fields
     * @param array<string, mixed>     $unusedEntry
     * @param array<string, mixed>     $formData
     */
    public static function captureSubmission(
        array $fields,
        array $unusedEntry,
        array $formData,
        int $entryId
    ): void {
        try {
            $config = ConnectorConfig::load();
            if (!$config->enabled) {
                return;
            }
            $formId = filter_var(
                $formData['id'] ?? null,
                FILTER_VALIDATE_INT,
                array('options' => array('min_range' => 1))
            );
            if ($formId === false) {
                throw new ConnectorException(ConnectorException::FORM_MAPPING_INVALID);
            }
            $formConfig = $config->form((int) $formId);
            if ($formConfig === null) {
                return;
            }
            $queue = self::queue();
            if (!$queue->isReady()) {
                throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
            }
            $envelope = EventContract::create(
                $fields,
                (int) $formId,
                $entryId,
                $formConfig
            );
            $queueSecret = SecretStore::readKey($config->queueKeyFile, ABSPATH);
            try {
                $encryptedBody = QueueCipher::encrypt(
                    $envelope->body,
                    $envelope->businessKeyDigest,
                    $envelope->bodyHash,
                    $config->activeKeyId,
                    $queueSecret
                );
            } finally {
                sodium_memzero($queueSecret);
            }
            $result = $queue->enqueue($envelope, $config->activeKeyId, $encryptedBody);
            if ($result->needsDelivery) {
                self::schedule(1);
            }
        } catch (\Throwable $error) {
            SafeLogger::captureFailure($error);
        }
    }

    public static function runWorker(): void
    {
        $config = null;
        $queue = null;
        try {
            $config = ConnectorConfig::load();
            if (!$config->enabled) {
                return;
            }
            $queue = self::queue();
            if (!$queue->isReady()) {
                throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
            }
            $worker = new QueueWorker($queue, new GatewayClient(new CurlGatewayTransport()));
            $summary = $worker->run($config, ABSPATH);
            SafeLogger::workerSummary($summary);
        } catch (\Throwable $error) {
            SafeLogger::workerFailure($error);
        } finally {
            if ($config instanceof ConnectorConfig && $config->enabled && $queue instanceof QueueStore) {
                try {
                    if ($queue->isReady() && $queue->hasOutstanding()) {
                        self::schedule($queue->nextDelaySeconds());
                    }
                } catch (\Throwable $error) {
                    SafeLogger::workerFailure($error);
                }
            }
        }
    }

    private static function queue(): QueueStore
    {
        global $wpdb;
        if (!is_object($wpdb)) {
            throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
        }
        return new QueueStore(new WordPressDatabase($wpdb));
    }

    private static function schedule(int $delaySeconds): void
    {
        $target = time() + max(1, min(3600, $delaySeconds));
        $existing = wp_next_scheduled(self::CRON_HOOK);
        if (is_int($existing) && $existing <= $target) {
            return;
        }
        if (
            is_int($existing)
            && wp_unschedule_event($existing, self::CRON_HOOK, array(), true) !== true
        ) {
            SafeLogger::scheduleFailure();
            return;
        }
        $scheduled = wp_schedule_single_event($target, self::CRON_HOOK, array(), true);
        if ($scheduled !== true) {
            SafeLogger::scheduleFailure();
        }
    }
}

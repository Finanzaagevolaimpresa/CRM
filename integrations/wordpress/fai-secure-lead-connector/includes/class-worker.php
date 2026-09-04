<?php

declare(strict_types=1);

namespace FAI\VNX02;

final class WorkerSummary
{
    public int $claimed = 0;
    public int $delivered = 0;
    public int $retried = 0;
    public int $terminal = 0;
    public int $exhausted = 0;
}

final class QueueWorker
{
    public function __construct(
        private readonly QueueStore $queue,
        private readonly GatewayClient $gateway
    ) {
    }

    public function run(ConnectorConfig $config, string $documentRoot): WorkerSummary
    {
        $summary = new WorkerSummary();
        for ($index = 0; $index < QueueStore::MAXIMUM_BATCH_SIZE; $index++) {
            $item = $this->queue->claim();
            if ($item === null) {
                break;
            }
            $summary->claimed++;
            $this->process($item, $config, $documentRoot, $summary);
        }
        return $summary;
    }

    private function process(
        QueueItem $item,
        ConnectorConfig $config,
        string $documentRoot,
        WorkerSummary $summary
    ): void {
        $queueSecret = null;
        try {
            $queueSecret = SecretStore::readKey($config->queueKeyFile, $documentRoot);
            $body = QueueCipher::decrypt(
                $item->encryptedBody,
                $item->businessKeyDigest,
                $item->bodyHash,
                $item->gatewayKeyId,
                $queueSecret
            );
            $envelope = EventContract::parseAndVerify($body);
            if (!hash_equals($item->businessKeyDigest, $envelope->businessKeyDigest)) {
                throw new ConnectorException(ConnectorException::QUEUE_INTEGRITY_FAILURE);
            }
            $gatewaySecret = SecretStore::readKey(
                $config->gatewayKeyFile($item->gatewayKeyId),
                $documentRoot
            );
            try {
                SecretStore::assertDistinctKeys($queueSecret, $gatewaySecret);
                $result = $this->gateway->deliver(
                    $config->gatewayUrl,
                    $item->gatewayKeyId,
                    $gatewaySecret,
                    $body
                );
            } finally {
                sodium_memzero($gatewaySecret);
            }
            $this->applyDeliveryResult($item, $result, $summary);
        } catch (ConnectorException $error) {
            if (in_array($error->safeCode, array(
                ConnectorException::QUEUE_INTEGRITY_FAILURE,
                ConnectorException::LEAD_EVENT_INVALID,
                ConnectorException::LEAD_EVENT_TOO_LARGE,
            ), true)) {
                $this->queue->terminal($item, 'QUEUE_INTEGRITY_FAILURE');
                $summary->terminal++;
                return;
            }
            $this->retry($item, 'CONFIGURATION_UNAVAILABLE', null, $summary);
        } catch (\Throwable) {
            $this->retry($item, 'INTERNAL_FAILURE', null, $summary);
        } finally {
            if (is_string($queueSecret)) {
                sodium_memzero($queueSecret);
            }
        }
    }

    private function applyDeliveryResult(
        QueueItem $item,
        DeliveryResult $result,
        WorkerSummary $summary
    ): void {
        if ($result->disposition === DeliveryResult::DELIVERED) {
            $this->queue->delivered($item);
            $summary->delivered++;
            return;
        }
        if ($result->disposition === DeliveryResult::TERMINAL) {
            $this->queue->terminal($item, $result->code);
            $summary->terminal++;
            return;
        }
        if ($result->disposition !== DeliveryResult::RETRY) {
            throw new ConnectorException(ConnectorException::INTERNAL_FAILURE);
        }
        $this->retry($item, $result->code, $result->suggestedDelaySeconds, $summary);
    }

    private function retry(
        QueueItem $item,
        string $code,
        ?int $suggestedDelay,
        WorkerSummary $summary
    ): void {
        if ($this->queue->retryOrExhaust($item, $code, $suggestedDelay)) {
            $summary->retried++;
        } else {
            $summary->exhausted++;
        }
    }
}

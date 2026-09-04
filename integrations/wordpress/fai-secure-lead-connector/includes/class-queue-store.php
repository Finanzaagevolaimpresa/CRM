<?php

declare(strict_types=1);

namespace FAI\VNX02;

final class QueueItem
{
    public function __construct(
        public readonly int $id,
        public readonly string $businessKeyDigest,
        public readonly string $bodyHash,
        public readonly string $gatewayKeyId,
        public readonly string $encryptedBody,
        public readonly int $attempt,
        public readonly string $leaseToken
    ) {
    }
}

final class EnqueueResult
{
    public function __construct(
        public readonly bool $inserted,
        public readonly bool $needsDelivery
    ) {
    }
}

final class QueueStore
{
    public const SCHEMA_VERSION = '1';
    public const MAXIMUM_BATCH_SIZE = 10;
    public const LEASE_SECONDS = 60;
    private const TABLE_SUFFIX = 'fai_vnx02_lead_queue';
    private const TOKEN_DOMAIN = 'fai.wordpress-secure-lead-connector.lease-token.v1';

    private readonly string $table;

    public function __construct(private readonly ConnectorDatabase $database)
    {
        $table = $database->tablePrefix() . self::TABLE_SUFFIX;
        if (preg_match('/\A[A-Za-z0-9_]+\z/D', $table) !== 1 || strlen($table) > 128) {
            throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
        }
        $this->table = $table;
    }

    public function install(): void
    {
        $this->database->installSchema($this->schemaSql());
        if (!$this->tableExists()) {
            throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
        }
        $this->database->setSchemaVersion(self::SCHEMA_VERSION);
    }

    public function isReady(): bool
    {
        return $this->database->schemaVersion() === self::SCHEMA_VERSION && $this->tableExists();
    }

    public function schemaSql(): string
    {
        $collate = trim($this->database->charsetCollate());
        if ($collate !== '' && preg_match('/\A(?:DEFAULT CHARACTER SET [A-Za-z0-9_]+ )?COLLATE [A-Za-z0-9_]+\z/D', $collate) !== 1) {
            throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
        }
        $suffix = $collate === '' ? '' : ' ' . $collate;
        return "CREATE TABLE {$this->table} (\n"
            . "id bigint(20) unsigned NOT NULL AUTO_INCREMENT,\n"
            . "business_key_digest char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n"
            . "submission_content_digest char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n"
            . "body_hash char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n"
            . "gateway_key_id varchar(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n"
            . "cipher_version tinyint(3) unsigned NOT NULL,\n"
            . "encrypted_body mediumtext NOT NULL,\n"
            . "status varchar(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,\n"
            . "attempt_count tinyint(3) unsigned NOT NULL DEFAULT 0,\n"
            . "available_at datetime(6) NOT NULL,\n"
            . "lease_token_digest char(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,\n"
            . "lease_expires_at datetime(6) DEFAULT NULL,\n"
            . "last_result_code varchar(32) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,\n"
            . "created_at datetime(6) NOT NULL,\n"
            . "updated_at datetime(6) NOT NULL,\n"
            . "PRIMARY KEY  (id),\n"
            . "UNIQUE KEY business_key_digest (business_key_digest),\n"
            . "UNIQUE KEY lease_token_digest (lease_token_digest),\n"
            . "KEY claim_ready (status,available_at,id),\n"
            . "KEY lease_recovery (status,lease_expires_at,id)\n"
            . ") ENGINE=InnoDB{$suffix};";
    }

    public function enqueue(
        EventEnvelope $envelope,
        string $gatewayKeyId,
        string $encryptedBody
    ): EnqueueResult {
        if (
            preg_match('/\A[A-Za-z0-9][A-Za-z0-9._:-]{2,79}\z/D', $gatewayKeyId) !== 1
            || $encryptedBody === ''
            || strlen($encryptedBody) > 32768
        ) {
            throw new ConnectorException(ConnectorException::QUEUE_INTEGRITY_FAILURE);
        }
        $query = $this->database->prepare(
            "INSERT INTO {$this->table} ("
                . 'business_key_digest,submission_content_digest,body_hash,gateway_key_id,'
                . 'cipher_version,encrypted_body,status,attempt_count,available_at,'
                . 'lease_token_digest,lease_expires_at,last_result_code,created_at,updated_at'
                . ") VALUES (%s,%s,%s,%s,1,%s,'PENDING',0,UTC_TIMESTAMP(6),NULL,NULL,NULL,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6)) "
                . 'ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)',
            array(
                $envelope->businessKeyDigest,
                $envelope->submissionContentDigest,
                $envelope->bodyHash,
                $gatewayKeyId,
                $encryptedBody,
            )
        );
        $result = $this->database->query($query);
        if ($result === false) {
            throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
        }
        $row = $this->database->row($this->database->prepare(
            "SELECT submission_content_digest,status FROM {$this->table} WHERE business_key_digest=%s LIMIT 1",
            array($envelope->businessKeyDigest)
        ));
        if (!is_array($row) || !is_string($row['submission_content_digest'] ?? null)) {
            throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
        }
        if (!hash_equals($envelope->submissionContentDigest, $row['submission_content_digest'])) {
            throw new ConnectorException(ConnectorException::IDEMPOTENCY_CONFLICT);
        }
        $status = $row['status'] ?? null;
        if (!is_string($status) || !in_array($status, array(
            'PENDING', 'LEASED', 'DELIVERED', 'TERMINAL', 'EXHAUSTED',
        ), true)) {
            throw new ConnectorException(ConnectorException::QUEUE_INTEGRITY_FAILURE);
        }
        return new EnqueueResult($result === 1, $status === 'PENDING' || $status === 'LEASED');
    }

    public function claim(?callable $randomBytes = null): ?QueueItem
    {
        $this->purgeExpiredExhausted();
        $random = $randomBytes ?? static fn (int $length): string => random_bytes($length);
        $leaseToken = $random(32);
        if (!is_string($leaseToken) || strlen($leaseToken) !== 32) {
            throw new ConnectorException(ConnectorException::INTERNAL_FAILURE);
        }
        $leaseToken = bin2hex($leaseToken);
        $leaseTokenDigest = hash('sha256', self::TOKEN_DOMAIN . "\n" . $leaseToken);
        if ($this->database->query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED') === false
            || $this->database->query('START TRANSACTION') === false) {
            throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
        }
        try {
            $row = null;
            foreach (array('LEASED' => 'lease_expires_at', 'PENDING' => 'available_at') as $status => $due) {
                $row = $this->database->row($this->database->prepare(
                    "SELECT id,business_key_digest,body_hash,gateway_key_id,cipher_version,encrypted_body,attempt_count "
                        . "FROM {$this->table} WHERE status=%s AND {$due}<=UTC_TIMESTAMP(6) "
                        . "AND attempt_count<%d ORDER BY {$due},id LIMIT 1 FOR UPDATE SKIP LOCKED",
                    array($status, RetryPolicy::MAXIMUM_ATTEMPTS)
                ));
                if ($row !== null) {
                    break;
                }
            }
            $item = null;
            if ($row !== null) {
                $row['attempt_count'] = (int) ($row['attempt_count'] ?? -1) + 1;
                $item = $this->queueItem($row, $leaseToken);
                $updated = $this->database->query($this->database->prepare(
                    "UPDATE {$this->table} SET status='LEASED',attempt_count=attempt_count+1,lease_token_digest=%s,"
                        . 'lease_expires_at=DATE_ADD(UTC_TIMESTAMP(6), INTERVAL %d SECOND),updated_at=UTC_TIMESTAMP(6) '
                        . 'WHERE id=%d AND attempt_count=%d',
                    array($leaseTokenDigest, self::LEASE_SECONDS, $item->id, $item->attempt - 1)
                ));
                if ($updated !== 1) {
                    throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
                }
            }
            if ($this->database->query('COMMIT') === false) {
                throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
            }
            return $item;
        } catch (\Throwable $error) {
            try {
                $this->database->query('ROLLBACK');
            } catch (\Throwable) {
                // Preserve the original safe failure; never expose database details.
            }
            throw $error;
        }
    }

    public function delivered(QueueItem $item): void
    {
        $this->finish($item, 'DELIVERED', 'DELIVERED');
    }

    public function terminal(QueueItem $item, string $code): void
    {
        $this->assertResultCode($code);
        $this->finish($item, 'TERMINAL', $code);
    }

    public function retryOrExhaust(QueueItem $item, string $code, ?int $suggestedDelay = null): bool
    {
        $this->assertResultCode($code);
        $delay = RetryPolicy::nextDelay($item->attempt, $suggestedDelay);
        $tokenDigest = hash('sha256', self::TOKEN_DOMAIN . "\n" . $item->leaseToken);
        if ($delay === null) {
            $query = $this->database->prepare(
                "UPDATE {$this->table} SET status='EXHAUSTED',encrypted_body='',lease_token_digest=NULL,"
                    . 'lease_expires_at=NULL,last_result_code=%s,updated_at=UTC_TIMESTAMP(6) '
                    . "WHERE id=%d AND status='LEASED' AND lease_token_digest=%s "
                    . 'AND lease_expires_at>UTC_TIMESTAMP(6)',
                array($code, $item->id, $tokenDigest)
            );
        } else {
            $query = $this->database->prepare(
                "UPDATE {$this->table} SET status='PENDING',available_at=DATE_ADD(UTC_TIMESTAMP(6), INTERVAL %d SECOND),"
                    . 'lease_token_digest=NULL,lease_expires_at=NULL,last_result_code=%s,updated_at=UTC_TIMESTAMP(6) '
                    . "WHERE id=%d AND status='LEASED' AND lease_token_digest=%s "
                    . 'AND lease_expires_at>UTC_TIMESTAMP(6)',
                array($delay, $code, $item->id, $tokenDigest)
            );
        }
        $updated = $this->database->query($query);
        if ($updated !== 1) {
            throw new ConnectorException(
                $updated === false ? ConnectorException::QUEUE_UNAVAILABLE : ConnectorException::LEASE_STALE
            );
        }
        return $delay !== null;
    }

    public function hasOutstanding(): bool
    {
        $value = $this->database->scalar(
            "SELECT COUNT(*) FROM {$this->table} WHERE status IN ('PENDING','LEASED')"
        );
        if (!is_numeric($value)) {
            throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
        }
        return (int) $value > 0;
    }

    public function nextDelaySeconds(): int
    {
        $value = $this->database->scalar(
            "SELECT TIMESTAMPDIFF(SECOND,UTC_TIMESTAMP(6),MIN(CASE WHEN status='PENDING' "
                . "THEN available_at ELSE lease_expires_at END)) FROM {$this->table} "
                . "WHERE status IN ('PENDING','LEASED')"
        );
        if ($value === null) {
            return 60;
        }
        if (!is_numeric($value)) {
            throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
        }
        return max(1, min(3600, (int) $value));
    }

    private function finish(QueueItem $item, string $status, string $code): void
    {
        $this->assertResultCode($code);
        $tokenDigest = hash('sha256', self::TOKEN_DOMAIN . "\n" . $item->leaseToken);
        $query = $this->database->prepare(
            "UPDATE {$this->table} SET status=%s,encrypted_body='',lease_token_digest=NULL,"
                . 'lease_expires_at=NULL,last_result_code=%s,updated_at=UTC_TIMESTAMP(6) '
                . "WHERE id=%d AND status='LEASED' AND lease_token_digest=%s "
                . 'AND lease_expires_at>UTC_TIMESTAMP(6)',
            array($status, $code, $item->id, $tokenDigest)
        );
        $updated = $this->database->query($query);
        if ($updated !== 1) {
            throw new ConnectorException(
                $updated === false ? ConnectorException::QUEUE_UNAVAILABLE : ConnectorException::LEASE_STALE
            );
        }
    }

    private function purgeExpiredExhausted(): void
    {
        $query = $this->database->prepare(
            "UPDATE {$this->table} SET status='EXHAUSTED',encrypted_body='',lease_token_digest=NULL,"
                . "lease_expires_at=NULL,last_result_code='RETRY_EXHAUSTED',updated_at=UTC_TIMESTAMP(6) "
                . "WHERE status='LEASED' AND lease_expires_at<=UTC_TIMESTAMP(6) AND attempt_count>=%d "
                . 'ORDER BY lease_expires_at,id LIMIT %d',
            array(RetryPolicy::MAXIMUM_ATTEMPTS, self::MAXIMUM_BATCH_SIZE)
        );
        if ($this->database->query($query) === false) {
            throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
        }
    }

    /**
     * @param array<string, mixed> $row
     */
    private function queueItem(array $row, string $leaseToken): QueueItem
    {
        $id = filter_var($row['id'] ?? null, FILTER_VALIDATE_INT, array('options' => array('min_range' => 1)));
        $attempt = filter_var(
            $row['attempt_count'] ?? null,
            FILTER_VALIDATE_INT,
            array('options' => array('min_range' => 1, 'max_range' => RetryPolicy::MAXIMUM_ATTEMPTS))
        );
        $businessKeyDigest = $row['business_key_digest'] ?? null;
        $bodyHash = $row['body_hash'] ?? null;
        $gatewayKeyId = $row['gateway_key_id'] ?? null;
        $encryptedBody = $row['encrypted_body'] ?? null;
        if (
            $id === false
            || $attempt === false
            || ($row['cipher_version'] ?? null) != 1
            || !is_string($businessKeyDigest)
            || preg_match('/\A[0-9a-f]{64}\z/D', $businessKeyDigest) !== 1
            || !is_string($bodyHash)
            || preg_match('/\A[0-9a-f]{64}\z/D', $bodyHash) !== 1
            || !is_string($gatewayKeyId)
            || preg_match('/\A[A-Za-z0-9][A-Za-z0-9._:-]{2,79}\z/D', $gatewayKeyId) !== 1
            || !is_string($encryptedBody)
            || $encryptedBody === ''
            || strlen($encryptedBody) > 32768
        ) {
            throw new ConnectorException(ConnectorException::QUEUE_INTEGRITY_FAILURE);
        }
        return new QueueItem(
            (int) $id,
            $businessKeyDigest,
            $bodyHash,
            $gatewayKeyId,
            $encryptedBody,
            (int) $attempt,
            $leaseToken
        );
    }

    private function tableExists(): bool
    {
        $value = $this->database->scalar($this->database->prepare(
            'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=%s',
            array($this->table)
        ));
        return is_numeric($value) && (int) $value === 1;
    }

    private function assertResultCode(string $code): void
    {
        if (!in_array($code, array(
            'DELIVERED',
            'INVALID_REQUEST',
            'UNAUTHORIZED',
            'CONFLICT',
            'RATE_LIMITED',
            'TEMPORARILY_UNAVAILABLE',
            'UNEXPECTED_RESPONSE',
            'QUEUE_INTEGRITY_FAILURE',
            'CONFIGURATION_UNAVAILABLE',
            'INTERNAL_FAILURE',
        ), true)) {
            throw new ConnectorException(ConnectorException::INTERNAL_FAILURE);
        }
    }
}

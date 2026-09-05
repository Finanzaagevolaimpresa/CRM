<?php

declare(strict_types=1);

use FAI\VNX02\ConnectorConfig;
use FAI\VNX02\ConnectorDatabase;
use FAI\VNX02\ConnectorException;
use FAI\VNX02\EventContract;
use FAI\VNX02\GatewayClient;
use FAI\VNX02\GatewayTransport;
use FAI\VNX02\QueueCipher;
use FAI\VNX02\QueueStore;
use FAI\VNX02\QueueWorker;
use FAI\VNX02\TransportResponse;

require_once __DIR__ . '/vnx02-bootstrap.php';

if (
    getenv('VNX02_MYSQL_TESTS_CONFIRMED') !== '1'
    || getenv('VNX02_MYSQL_HOST') !== '127.0.0.1'
    || getenv('VNX02_MYSQL_DATABASE') !== 'fai_vnx02_test'
) {
    fwrite(STDERR, "VNX02_MYSQL_TEST_GUARD_FAILED\n");
    exit(1);
}

final class Vnx02MysqliDatabase implements ConnectorDatabase
{
    private string $version = '';

    public function __construct(
        public readonly mysqli $connection,
        private readonly string $prefix
    ) {
    }

    public function tablePrefix(): string
    {
        return $this->prefix;
    }

    public function charsetCollate(): string
    {
        return 'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin';
    }

    public function prepare(string $query, array $values): string
    {
        $index = 0;
        $prepared = preg_replace_callback('/%[ds]/', function (array $match) use ($values, &$index): string {
            if (!array_key_exists($index, $values)) {
                throw new RuntimeException('SYNTHETIC_PREPARE_VALUE_MISSING');
            }
            $value = $values[$index++];
            if ($match[0] === '%d') {
                if (!is_int($value)) {
                    throw new RuntimeException('SYNTHETIC_PREPARE_INTEGER_INVALID');
                }
                return (string) $value;
            }
            if (!is_string($value)) {
                throw new RuntimeException('SYNTHETIC_PREPARE_STRING_INVALID');
            }
            return "'" . $this->connection->real_escape_string($value) . "'";
        }, $query);
        if (!is_string($prepared) || $index !== count($values)) {
            throw new RuntimeException('SYNTHETIC_PREPARE_INVALID');
        }
        return $prepared;
    }

    public function query(string $query): int|false
    {
        $this->connection->query($query);
        return $this->connection->affected_rows;
    }

    public function row(string $query): ?array
    {
        $result = $this->connection->query($query);
        if (!$result instanceof mysqli_result) {
            throw new RuntimeException('SYNTHETIC_QUERY_RESULT_INVALID');
        }
        $row = $result->fetch_assoc();
        $result->free();
        return is_array($row) ? $row : null;
    }

    public function scalar(string $query): mixed
    {
        $result = $this->connection->query($query);
        if (!$result instanceof mysqli_result) {
            throw new RuntimeException('SYNTHETIC_QUERY_RESULT_INVALID');
        }
        $row = $result->fetch_row();
        $result->free();
        return is_array($row) ? ($row[0] ?? null) : null;
    }

    public function installSchema(string $query): void
    {
        $this->connection->query($query);
    }

    public function schemaVersion(): string
    {
        return $this->version;
    }

    public function setSchemaVersion(string $version): void
    {
        $this->version = $version;
    }
}

function vnx02_mysql_connection(): mysqli
{
    $port = getenv('VNX02_MYSQL_PORT');
    if (!is_string($port) || preg_match('/\A\d{1,5}\z/D', $port) !== 1) {
        throw new RuntimeException('SYNTHETIC_MYSQL_PORT_INVALID');
    }
    mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
    $connection = new mysqli(
        '127.0.0.1',
        (string) getenv('VNX02_MYSQL_USER'),
        (string) getenv('VNX02_MYSQL_PASSWORD'),
        'fai_vnx02_test',
        (int) $port
    );
    $connection->set_charset('utf8mb4');
    $result = $connection->query('SELECT DATABASE()');
    $row = $result->fetch_row();
    $result->free();
    if (($row[0] ?? null) !== 'fai_vnx02_test') {
        throw new RuntimeException('SYNTHETIC_MYSQL_DATABASE_INVALID');
    }
    return $connection;
}

function vnx02_mysql_assert(bool $condition): void
{
    if (!$condition) {
        throw new RuntimeException('SYNTHETIC_MYSQL_ASSERT_FAILED');
    }
}

/**
 * @return array<int, string>
 */
function vnx02_mysql_parallel_claims(string $prefix, int $workers): array
{
    $processes = array();
    for ($index = 0; $index < $workers; $index++) {
        $descriptor = array(
            0 => array('pipe', 'r'),
            1 => array('pipe', 'w'),
            2 => array('pipe', 'w'),
        );
        $pipes = array();
        $process = proc_open(
            array(PHP_BINARY, __FILE__, 'claim-child', $prefix),
            $descriptor,
            $pipes,
            dirname(__DIR__, 2),
            null,
            array('bypass_shell' => true)
        );
        if (!is_resource($process)) {
            throw new RuntimeException('SYNTHETIC_PROCESS_START_FAILED');
        }
        fclose($pipes[0]);
        $processes[] = array($process, $pipes);
    }
    $outcomes = array();
    foreach ($processes as [$process, $pipes]) {
        $stdout = stream_get_contents($pipes[1]);
        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $status = proc_close($process);
        if ($status !== 0 || $stderr !== '') {
            fwrite(STDERR, 'SYNTHETIC_CLAIM_PROCESS_STATUS=' . $status . "\n");
            if (is_string($stderr) && preg_match('/\ASYNTHETIC_CHILD_[A-Za-z0-9_\\\\: -]+\n\z/D', $stderr) === 1) {
                fwrite(STDERR, $stderr);
            }
        }
        vnx02_mysql_assert($status === 0 && $stderr === '');
        $outcomes[] = $stdout;
    }
    return $outcomes;
}

function vnx02_mysql_envelope(string $message, int $entryId): FAI\VNX02\EventEnvelope
{
    $config = ConnectorConfig::fromArray(vnx02_synthetic_config());
    $fields = vnx02_synthetic_fields();
    $fields[11]['value'] = $message;
    return EventContract::create($fields, 900001, $entryId, $config->form(900001));
}

final class Vnx02OfflineTransport implements GatewayTransport
{
    public int $calls = 0;

    public function post(string $url, array $headers, string $body, int $timeoutMilliseconds): TransportResponse
    {
        $this->calls++;
        EventContract::parseAndVerify($body);
        return new TransportResponse(202, '{"ok":true,"receipt":"slg2_00000000000000000000000000000000"}', null);
    }
}

if (($argv[1] ?? '') === 'claim-child') {
    $prefix = $argv[2] ?? '';
    if (!is_string($prefix) || preg_match('/\Avnx02_[0-9a-f]{12}_\z/D', $prefix) !== 1) {
        exit(2);
    }
    try {
        $queue = new QueueStore(new Vnx02MysqliDatabase(vnx02_mysql_connection(), $prefix));
        $claimed = $queue->claim();
        echo $claimed === null ? 'EMPTY' : 'CLAIMED';
        exit(0);
    } catch (Throwable $error) {
        fwrite(STDERR, 'SYNTHETIC_CHILD_' . get_class($error) . ':' . (int) $error->getCode() . "\n");
        exit(3);
    }
}

$connection = vnx02_mysql_connection();
$prefix = 'vnx02_' . bin2hex(random_bytes(6)) . '_';
$table = $prefix . 'fai_vnx02_lead_queue';
$database = new Vnx02MysqliDatabase($connection, $prefix);
$queue = new QueueStore($database);
$queueSecret = hex2bin(str_repeat('22', 32));
$temporaryRoot = sys_get_temp_dir() . '/' . $prefix;
if (!mkdir($temporaryRoot . '/web', 0700, true)) {
    throw new RuntimeException('SYNTHETIC_WORKER_TEMP_FAILED');
}

try {
    $queue->install();
    vnx02_mysql_assert($queue->isReady());

    $envelope = vnx02_mysql_envelope('Synthetic concurrent queue item.', 710001);
    $encrypted = QueueCipher::encrypt(
        $envelope->body,
        $envelope->businessKeyDigest,
        $envelope->bodyHash,
        'synthetic-wordpress-v1',
        $queueSecret
    );
    $first = $queue->enqueue($envelope, 'synthetic-wordpress-v1', $encrypted);
    vnx02_mysql_assert($first->inserted && $first->needsDelivery);

    $replayEnvelope = vnx02_mysql_envelope('Synthetic concurrent queue item.', 710001);
    $replayEncrypted = QueueCipher::encrypt(
        $replayEnvelope->body,
        $replayEnvelope->businessKeyDigest,
        $replayEnvelope->bodyHash,
        'synthetic-wordpress-v1',
        $queueSecret
    );
    $replay = $queue->enqueue($replayEnvelope, 'synthetic-wordpress-v1', $replayEncrypted);
    vnx02_mysql_assert(!$replay->inserted && $replay->needsDelivery);
    try {
        $conflictEnvelope = vnx02_mysql_envelope('Synthetic divergent queue item.', 710001);
        $queue->enqueue($conflictEnvelope, 'synthetic-wordpress-v1', QueueCipher::encrypt(
            $conflictEnvelope->body,
            $conflictEnvelope->businessKeyDigest,
            $conflictEnvelope->bodyHash,
            'synthetic-wordpress-v1',
            $queueSecret
        ));
        throw new RuntimeException('SYNTHETIC_CONFLICT_NOT_DETECTED');
    } catch (ConnectorException $error) {
        vnx02_mysql_assert($error->safeCode === ConnectorException::IDEMPOTENCY_CONFLICT);
    }

    $stored = $database->row("SELECT encrypted_body,status,attempt_count FROM {$table} LIMIT 1");
    vnx02_mysql_assert(is_array($stored));
    vnx02_mysql_assert(!str_contains($stored['encrypted_body'], 'synthetic.lead@n10.invalid'));
    vnx02_mysql_assert(!str_contains($stored['encrypted_body'], 'Synthetic concurrent queue item.'));

    $outcomes = vnx02_mysql_parallel_claims($prefix, 8);
    vnx02_mysql_assert(count(array_filter($outcomes, fn ($value) => $value === 'CLAIMED')) === 1);
    vnx02_mysql_assert(count(array_filter($outcomes, fn ($value) => $value === 'EMPTY')) === 7);

    $connection->query(
        "UPDATE {$table} SET lease_expires_at=DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND)"
    );
    $recovered = $queue->claim(static fn (int $length): string => str_repeat("\x55", $length));
    vnx02_mysql_assert($recovered !== null && $recovered->attempt === 2);
    $decoded = QueueCipher::decrypt(
        $recovered->encryptedBody,
        $recovered->businessKeyDigest,
        $recovered->bodyHash,
        $recovered->gatewayKeyId,
        $queueSecret
    );
    vnx02_mysql_assert(EventContract::parseAndVerify($decoded)->body === $envelope->body);
    $queue->delivered($recovered);
    $delivered = $database->row(
        "SELECT status,encrypted_body,last_result_code FROM {$table} LIMIT 1"
    );
    vnx02_mysql_assert($delivered === array(
        'status' => 'DELIVERED',
        'encrypted_body' => '',
        'last_result_code' => 'DELIVERED',
    ));

    for ($ordinal = 1; $ordinal <= 8; $ordinal++) {
        $parallelEnvelope = vnx02_mysql_envelope(
            "Synthetic parallel queue item {$ordinal}.",
            720000 + $ordinal
        );
        $queue->enqueue($parallelEnvelope, 'synthetic-wordpress-v1', QueueCipher::encrypt(
            $parallelEnvelope->body,
            $parallelEnvelope->businessKeyDigest,
            $parallelEnvelope->bodyHash,
            'synthetic-wordpress-v1',
            $queueSecret
        ));
    }
    $parallelOutcomes = vnx02_mysql_parallel_claims($prefix, 16);
    vnx02_mysql_assert(count(array_filter(
        $parallelOutcomes,
        fn ($value) => $value === 'CLAIMED'
    )) === 8);
    vnx02_mysql_assert(count(array_filter(
        $parallelOutcomes,
        fn ($value) => $value === 'EMPTY'
    )) === 8);
    $leaseCounts = $database->row(
        "SELECT COUNT(*) AS rows_claimed,COUNT(DISTINCT lease_token_digest) AS unique_tokens "
        . "FROM {$table} WHERE status='LEASED'"
    );
    vnx02_mysql_assert($leaseCounts === array('rows_claimed' => '8', 'unique_tokens' => '8'));
    $connection->query(
        "UPDATE {$table} SET status='TERMINAL',encrypted_body='',lease_token_digest=NULL,"
        . "lease_expires_at=NULL,last_result_code='INVALID_REQUEST' WHERE status='LEASED'"
    );

    $retryEnvelope = vnx02_mysql_envelope('Synthetic bounded retry item.', 710002);
    $queue->enqueue($retryEnvelope, 'synthetic-wordpress-v1', QueueCipher::encrypt(
        $retryEnvelope->body,
        $retryEnvelope->businessKeyDigest,
        $retryEnvelope->bodyHash,
        'synthetic-wordpress-v1',
        $queueSecret
    ));
    for ($attempt = 1; $attempt <= 5; $attempt++) {
        $connection->query(
            "UPDATE {$table} SET available_at=DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND) "
            . "WHERE business_key_digest='{$retryEnvelope->businessKeyDigest}' AND status='PENDING'"
        );
        $item = $queue->claim(static fn (int $length): string => str_repeat(chr(96 + $attempt), $length));
        vnx02_mysql_assert($item !== null && $item->attempt === $attempt);
        $willRetry = $queue->retryOrExhaust($item, 'TEMPORARILY_UNAVAILABLE');
        vnx02_mysql_assert($willRetry === ($attempt < 5));
    }
    $exhausted = $database->row(
        "SELECT status,encrypted_body,attempt_count FROM {$table} "
        . "WHERE business_key_digest='{$retryEnvelope->businessKeyDigest}'"
    );
    vnx02_mysql_assert($exhausted === array(
        'status' => 'EXHAUSTED',
        'encrypted_body' => '',
        'attempt_count' => '5',
    ));

    $workerConfig = vnx02_synthetic_config();
    $workerConfig['queue_key_file'] = $temporaryRoot . '/queue-key';
    $workerConfig['gateway_key_files']['synthetic-wordpress-v1'] = $temporaryRoot . '/gateway-key';
    file_put_contents($workerConfig['queue_key_file'], base64_encode($queueSecret));
    file_put_contents($workerConfig['gateway_key_files']['synthetic-wordpress-v1'], base64_encode(str_repeat("\x11", 32)));
    chmod($workerConfig['queue_key_file'], 0600);
    chmod($workerConfig['gateway_key_files']['synthetic-wordpress-v1'], 0600);
    $validatedWorkerConfig = ConnectorConfig::fromArray($workerConfig);
    $transport = new Vnx02OfflineTransport();
    $worker = new QueueWorker($queue, new GatewayClient($transport));
    $workerEnvelope = vnx02_mysql_envelope('Synthetic worker delivery.', 730001);
    $queue->enqueue($workerEnvelope, 'synthetic-wordpress-v1', QueueCipher::encrypt(
        $workerEnvelope->body, $workerEnvelope->businessKeyDigest, $workerEnvelope->bodyHash,
        'synthetic-wordpress-v1', $queueSecret
    ));
    $summary = $worker->run($validatedWorkerConfig, $temporaryRoot . '/web');
    vnx02_mysql_assert($summary->claimed === 1 && $summary->delivered === 1 && $transport->calls === 1);

    $missingKeyEnvelope = vnx02_mysql_envelope('Synthetic missing key bounded recovery.', 730002);
    $queue->enqueue($missingKeyEnvelope, 'synthetic-wordpress-v1', QueueCipher::encrypt(
        $missingKeyEnvelope->body, $missingKeyEnvelope->businessKeyDigest, $missingKeyEnvelope->bodyHash,
        'synthetic-wordpress-v1', $queueSecret
    ));
    unlink($workerConfig['queue_key_file']);
    for ($attempt = 1; $attempt <= 5; $attempt++) {
        $connection->query("UPDATE {$table} SET available_at=DATE_SUB(UTC_TIMESTAMP(6), INTERVAL 1 SECOND) WHERE status='PENDING'");
        $summary = $worker->run($validatedWorkerConfig, $temporaryRoot . '/web');
        vnx02_mysql_assert($summary->claimed === 1 && $summary->retried === ($attempt < 5 ? 1 : 0));
        vnx02_mysql_assert($summary->exhausted === ($attempt === 5 ? 1 : 0));
    }
    vnx02_mysql_assert($transport->calls === 1 && !$queue->hasOutstanding());
    echo "VNX02 MySQL integration PASS\n";
} finally {
    $connection->query("DROP TABLE IF EXISTS {$table}");
    $connection->close();
    @unlink($temporaryRoot . '/queue-key');
    @unlink($temporaryRoot . '/gateway-key');
    @rmdir($temporaryRoot . '/web');
    @rmdir($temporaryRoot);
}

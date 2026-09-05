<?php

declare(strict_types=1);

namespace FAI\VNX02;

interface ConnectorDatabase
{
    public function tablePrefix(): string;

    public function charsetCollate(): string;

    /**
     * @param array<int, int|string> $values
     */
    public function prepare(string $query, array $values): string;

    public function query(string $query): int|false;

    /**
     * @return array<string, mixed>|null
     */
    public function row(string $query): ?array;

    public function scalar(string $query): mixed;

    public function installSchema(string $query): void;

    public function schemaVersion(): string;

    public function setSchemaVersion(string $version): void;
}
final class WordPressDatabase implements ConnectorDatabase
{
    public function __construct(private readonly object $database)
    {
    }

    public function tablePrefix(): string
    {
        $prefix = $this->database->prefix ?? null;
        if (!is_string($prefix)) {
            throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
        }
        return $prefix;
    }

    public function charsetCollate(): string
    {
        $value = $this->database->get_charset_collate();
        return is_string($value) ? $value : '';
    }

    public function prepare(string $query, array $values): string
    {
        $prepared = $this->database->prepare($query, ...$values);
        if (!is_string($prepared)) {
            throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
        }
        return $prepared;
    }

    public function query(string $query): int|false
    {
        $previous = $this->database->suppress_errors(true);
        try {
            $result = $this->database->query($query);
            return is_int($result) ? $result : false;
        } finally {
            $this->database->suppress_errors($previous);
        }
    }

    public function row(string $query): ?array
    {
        if ($this->query($query) === false) {
            throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
        }
        $result = $this->database->last_result[0] ?? null;
        return is_object($result) ? get_object_vars($result) : null;
    }

    public function scalar(string $query): mixed
    {
        if ($this->query($query) === false) {
            throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
        }
        return $this->database->get_var();
    }

    public function installSchema(string $query): void
    {
        require_once ABSPATH . 'wp-admin/includes/upgrade.php';
        $previous = $this->database->suppress_errors(true);
        try {
            $result = dbDelta($query);
        } finally {
            $this->database->suppress_errors($previous);
        }
        if (!is_array($result)) {
            throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
        }
    }

    public function schemaVersion(): string
    {
        $value = get_option('fai_vnx02_connector_schema_version', '');
        return is_string($value) ? $value : '';
    }

    public function setSchemaVersion(string $version): void
    {
        if (!update_option('fai_vnx02_connector_schema_version', $version, false)) {
            $current = get_option('fai_vnx02_connector_schema_version', '');
            if ($current !== $version) {
                throw new ConnectorException(ConnectorException::QUEUE_UNAVAILABLE);
            }
        }
    }
}

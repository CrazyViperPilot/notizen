<?php
// Database helpers. SQL uses {table} placeholders that become the prefixed table name, e.g.
//   one('SELECT * FROM {users} WHERE id = ?', [$id])

function db()
{
    if (isset($GLOBALS['NZ_PDO'])) return $GLOBALS['NZ_PDO'];
    $c = cfg('db');
    $dsn = 'mysql:host=' . $c['host'] . ';port=' . (int)(isset($c['port']) ? $c['port'] : 3306)
        . ';dbname=' . $c['name'] . ';charset=utf8mb4';
    $pdo = new PDO($dsn, $c['user'], $c['pass'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_STRINGIFY_FETCHES => false,
    ]);
    $pdo->exec("SET SESSION sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'");
    $GLOBALS['NZ_PDO'] = $pdo;
    $GLOBALS['NZ_TX'] = 0;
    return $pdo;
}

/** Prefixed, quoted table name. */
function t($name)
{
    return '`' . cfg('db')['prefix'] . $name . '`';
}

function sql_tables($sql)
{
    return preg_replace_callback('/\{([a-z_]+)\}/', function ($m) { return t($m[1]); }, $sql);
}

/** Prepared statement, executed. */
function q($sql, array $params = [])
{
    $st = db()->prepare(sql_tables($sql));
    $st->execute(array_values($params));
    return $st;
}

/** First row or null. */
function one($sql, array $params = [])
{
    $row = q($sql, $params)->fetch();
    return $row === false ? null : $row;
}

/** All rows. */
function all($sql, array $params = [])
{
    return q($sql, $params)->fetchAll();
}

/** Single value of the first row or null. */
function val($sql, array $params = [])
{
    $v = q($sql, $params)->fetchColumn();
    return $v === false ? null : $v;
}

/** Runs $fn inside a transaction (nested calls join the outer one). Returns $fn's result. */
function tx(callable $fn)
{
    $pdo = db();
    if ($GLOBALS['NZ_TX'] > 0) return $fn();
    $pdo->beginTransaction();
    $GLOBALS['NZ_TX'] = 1;
    try {
        $r = $fn();
        $pdo->commit();
        $GLOBALS['NZ_TX'] = 0;
        return $r;
    } catch (Throwable $e) {
        $GLOBALS['NZ_TX'] = 0;
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

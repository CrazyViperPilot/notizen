<?php
// Vorlage. Auf dem Server erzeugt der Deploy-Workflow config.php aus den Repository-Secrets.
// Lokal: nach config.php kopieren und anpassen (config.php ist in .gitignore).
// admin.password_hash: php -r 'echo password_hash("PASSWORT", PASSWORD_DEFAULT);'
// admin.fp:            php -r 'echo hash("sha256", "BENUTZER\nPASSWORT");'
return [
    'db' => ['host' => '127.0.0.1', 'port' => 3306, 'name' => 'notizen', 'user' => 'notizen', 'pass' => 'notizen', 'prefix' => 'notizen_'],
    'base_path' => '/',
    'cookie_secure' => false,
    'admin' => [
        'username' => 'admin',
        'password_hash' => '',
        'fp' => '',
    ],
];

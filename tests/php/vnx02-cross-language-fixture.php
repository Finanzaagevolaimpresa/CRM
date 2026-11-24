<?php

declare(strict_types=1);

use FAI\VNX02\ConnectorConfig;
use FAI\VNX02\EventContract;
use FAI\VNX02\GatewayProtocol;

require_once __DIR__ . '/vnx02-bootstrap.php';

$configuration = vnx02_synthetic_config();
$fields = vnx02_synthetic_fields();
$vae = in_array($argv[1] ?? '', array('vae-meta', 'vae-chatgpt'), true);
$site = 'https://intake.synthetic.invalid/';
$page = $vae ? $site . 'valutazione/?utm_source=' . substr($argv[1], 4) . '&utm_campaign=VAE-TEST&utm_content=AD-01' : null;
if (($argv[1] ?? '') === 'campaign') {
    $configuration['forms'][900001]['field_map']['campaignCode'] = 15;
    $configuration['forms'][900001]['field_map']['adCode'] = 16;
    $fields[15] = array('value' => 'AUTUNNO-26');
    $fields[16] = array('value' => 'META:02');
}
$fields[1]['value'] = " Cafe\u{0301} \u{1F600} \u{FEFF}";
$fields[5]['value'] = "+39\u{FEFF}333\u{00A0}000\t0010";
$fields[10]['value'] = '90071992547409,91';
$evaluation = in_array($argv[1] ?? '', array('evaluation-existing', 'evaluation-planned', 'evaluation-legacy'), true);
if ($evaluation) {
    $form = $configuration['forms'][900001];
    $form['form_code'] = 'FAI_GENERAL_REQUEST';
    $form['form_version'] = 'public-intake-2026-10-r01';
    $form['field_map'] = array('firstName' => array('field_id'=>1, 'part'=>'first'),
        'lastName' => array('field_id'=>1, 'part'=>'last'), 'email'=>2, 'phone'=>3,
        'companyName'=>4, 'serviceInterestText'=>5, 'message'=>6);
    $form['requested_amount_mode'] = null;
    $form['catalog_reference'] = null;
    $form['privacy']['service']['field_id'] = 7;
    $form['privacy']['marketing']['field_id'] = 8;
    $configuration['forms'] = array(4 => $form);
    $fields = array(
        1 => array('type'=>'name','first'=>'Persona','last'=>'Sintetica','value'=>'Persona Sintetica'),
        2 => array('value'=>'form4@synthetic.invalid'), 3 => array('value'=>'+390000000024'),
        4 => array('value'=>'Progetto sintetico'), 5 => array('value'=>'Servizio di prova'),
        6 => array('value'=>"Descrizione originale.\nSeconda riga."),
        7 => array('value'=>'SYNTHETIC_SERVICE_ACCEPTED'), 8 => array('value'=>'SYNTHETIC_MARKETING_DENIED'),
    );
    if ($argv[1] !== 'evaluation-legacy') {
        $existing = $argv[1] === 'evaluation-existing';
        $fields += array(9=>array('value'=>'Comune sintetico'),10=>array('value'=>'Provincia sintetica'),
            11=>array('value'=>$existing ? 'Già costituita' : 'Da costituire'),
            12=>array('value'=>$existing ? 'Forma di prova' : 'Valore residuo del controllo nascosto'),
            13=>array('value'=>'39'));
        $page = $existing ? $site.'valutazione/?utm_source=meta&utm_campaign=TEST-4'
            : 'https://other.synthetic.invalid/valutazione/?utm_source=meta';
    }
}
$config = ConnectorConfig::fromArray($configuration);
$envelope = EventContract::create(
    $fields,
    $vae || $evaluation ? 4 : 900001,
    700001,
    $config->form($evaluation ? 4 : 900001),
    new DateTimeImmutable('2026-08-21T12:00:00.000Z'),
    vnx02_deterministic_random(),
    $page,
    $vae || $evaluation ? $site : null
);
if (EventContract::parseAndVerify($envelope->body)->body !== $envelope->body) {
    throw new RuntimeException('Canonical PHP round trip failed');
}
$keyId = 'synthetic-wordpress-v1';
$timestamp = '1787313600';
$nonce = '0123456789abcdef0123456789abcdef';
$secret = hex2bin('1111111111111111111111111111111111111111111111111111111111111111');
$signedBytes = GatewayProtocol::signedBytes($keyId, $timestamp, $nonce, $envelope->body);
$output = array(
    'body' => $envelope->body,
    'businessKeyDigest' => $envelope->businessKeyDigest,
    'payloadHash' => $envelope->payloadHash,
    'bodyHash' => $envelope->bodyHash,
    'keyId' => $keyId,
    'timestamp' => $timestamp,
    'nonce' => $nonce,
    'signedBytesBase64' => base64_encode($signedBytes),
    'signature' => GatewayProtocol::signature($secret, $signedBytes),
);
echo json_encode($output, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);

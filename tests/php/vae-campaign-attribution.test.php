<?php

declare(strict_types=1);

use FAI\VNX02\VaeCampaignAttribution;
use FAI\VNX02\EventContract;
use FAI\VNX02\ConnectorException;

require_once __DIR__ . '/vnx02-bootstrap.php';
$site = 'https://intake.synthetic.invalid/';
$url = $site . 'valutazione/';
$cases = array(
    'meta' => array('?utm_source=meta&utm_campaign=VAE-TEST&utm_content=AD-01', array('campaignPlatform'=>'META','campaignCode'=>'VAE-TEST','adCode'=>'AD-01')),
    'chatgpt' => array('?utm_source=ChatGPT&utm_campaign=VAE.TEST&utm_content=AD:02', array('campaignPlatform'=>'CHATGPT','campaignCode'=>'VAE.TEST','adCode'=>'AD:02')),
    'organic' => array('', array()),
    'unrelated-query' => array('?email=not-retained%40invalid.test&gclid=not-retained', array()),
    'partial-source' => array('?utm_source=meta', array('campaignPlatform'=>'META')),
    'partial-code' => array('?utm_campaign=C-1', array('campaignCode'=>'C-1')),
    'empty-utm' => array('?utm_source=&utm_campaign=&utm_content=', array()),
    'unknown-source' => array('?utm_source=unknown&utm_content=AD', array('adCode'=>'AD')),
    'decoded-once' => array('?utm_source=chatgpt&utm_campaign=C%2D1&utm_content=A%3A1', array('campaignPlatform'=>'CHATGPT','campaignCode'=>'C-1','adCode'=>'A:1')),
    'duplicate' => array('?utm_source=meta&utm_source=chatgpt&utm_campaign=C', array()),
    'encoded-duplicate' => array('?utm_source=meta&utm%5Fsource=meta', array()),
    'array-parameter' => array('?utm_source=meta&utm_campaign%5B%5D=C', array()),
    'no-free-text' => array('?utm_campaign=two+words&utm_content=user%40invalid.test', array()),
    'no-url' => array('?utm_campaign=https%3A%2F%2Fexample.invalid&utm_content=utm%3Dx%26x%3Dy', array()),
    'bounds' => array('?utm_campaign='.str_repeat('a',80).'&utm_content='.str_repeat('b',81), array('campaignCode'=>str_repeat('a',80))),
    'control-value' => array('?utm_source=meta%0A&utm_content=A%0D', array()),
    'double-encoding' => array('?utm_campaign=C%252D1', array()),
    'fragment' => array('?utm_source=meta#other', array()),
);
$count = 0;
foreach ($cases as $name=>$case) {
    $actual=VaeCampaignAttribution::fromPageUrl(4,$url.$case[0],$site);
    if($actual!==$case[1]) { throw new RuntimeException('VAE_ASSERT_'.$name); }
    ++$count; echo 'PASS '.$name."\n";
}
foreach (array(
    array(5,$url.'?utm_source=meta',$site),
    array(4,null,$site),array(4,$url.'?utm_source=meta',null),
    array(4,'https://other.invalid/valutazione/?utm_source=meta',$site),
    array(4,'http://intake.synthetic.invalid/valutazione/?utm_source=meta',$site),
    array(4,'https://user@intake.synthetic.invalid/valutazione/?utm_source=meta',$site),
    array(4,'https://intake.synthetic.invalid:444/valutazione/?utm_source=meta',$site),
    array(4,$site.'other/?utm_source=meta',$site),
    array(4,$url.'?utm_source=meta&x='.str_repeat('x',4096),$site),
) as $args) {
    if(VaeCampaignAttribution::fromPageUrl(...$args)!==array()) { throw new RuntimeException('VAE_ORIGIN_SCOPE_ASSERT'); }
    ++$count;
}
$config=vnx02_synthetic_config()['forms'][900001];
$at=new DateTimeImmutable('2026-11-17T12:00:00.000Z');
$old=EventContract::create(vnx02_synthetic_fields(),4,700001,$config,$at,vnx02_deterministic_random());
$organic=EventContract::create(vnx02_synthetic_fields(),4,700001,$config,$at,vnx02_deterministic_random(),$url,$site);
if($old->body!==$organic->body){throw new RuntimeException('VAE_ORGANIC_CHANGED');} ++$count;
foreach(array('meta'=>'META','chatgpt'=>'CHATGPT') as $source=>$platform){
    $event=EventContract::create(vnx02_synthetic_fields(),4,700001,$config,$at,vnx02_deterministic_random(),$url.'?utm_source='.$source.'&utm_campaign=C-1&utm_content=A-1',$site);
    $parsed=EventContract::parseAndVerify($event->body);
    if($parsed->body!==$event->body || $event->businessKeyDigest!==$old->businessKeyDigest
        || $event->payloadHash===$old->payloadHash || $event->event['source']['systemCode']!=='WORDPRESS'
        || $event->event['privacy']['marketing']['decision']!=='DENIED'
        || $event->event['payload']['campaignPlatform']!==$platform){throw new RuntimeException('VAE_EVENT_ASSERT');}
    ++$count;
}
$config['field_map']['campaignCode']=15;
$fields=vnx02_synthetic_fields();$fields[15]=array('value'=>'OTHER');
try {
    EventContract::create($fields,4,700001,$config,$at,vnx02_deterministic_random(),$url.'?utm_campaign=C-1',$site);
    throw new RuntimeException('VAE_CONFLICT_NOT_REJECTED');
} catch(ConnectorException $e) {
    if($e->safeCode!==ConnectorException::FORM_MAPPING_INVALID){throw $e;} ++$count;
}
echo 'VAE attribution tests passed: '.$count."\n";

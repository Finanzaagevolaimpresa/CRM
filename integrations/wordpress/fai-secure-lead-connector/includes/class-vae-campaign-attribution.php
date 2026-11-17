<?php

declare(strict_types=1);

namespace FAI\VNX02;

/** Optional, untrusted attribution from the admitted VAE form; never a provider claim. */
final class VaeCampaignAttribution
{
    /** @return array<string, string> */
    public static function fromPageUrl(int $formId, ?string $pageUrl, ?string $siteUrl): array
    {
        if ($formId !== 4 || $pageUrl === null || $siteUrl === null || strlen($pageUrl) > 4096
            || preg_match('/[\x00-\x20\x7F\\\\]/', $pageUrl) === 1) {
            return array();
        }
        $url = parse_url($pageUrl);
        $site = parse_url($siteUrl);
        if (!is_array($site) || ($site['scheme'] ?? null) !== 'https'
            || empty($site['host']) || isset($site['user']) || isset($site['pass'])
            || !is_array($url) || ($url['scheme'] ?? null) !== 'https'
            || strtolower($url['host'] ?? '') !== strtolower($site['host'])
            || !in_array($url['path'] ?? '', array('/valutazione', '/valutazione/'), true)
            || isset($url['user']) || isset($url['pass']) || isset($url['fragment'])
            || ($url['port'] ?? 443) !== ($site['port'] ?? 443)) {
            return array();
        }
        $values = array();
        foreach (explode('&', $url['query'] ?? '') as $part) {
            $pair = explode('=', $part, 2);
            $key = strtolower(urldecode($pair[0]));
            if (preg_match('/\Autm_(source|campaign|content)\[/', $key) === 1) {
                return array();
            }
            if (!in_array($key, array('utm_source', 'utm_campaign', 'utm_content'), true)) {
                continue;
            }
            if (array_key_exists($key, $values)) {
                return array(); // Never choose one duplicated query value.
            }
            $values[$key] = urldecode($pair[1] ?? '');
        }
        $result = array();
        $platform = strtolower($values['utm_source'] ?? '');
        if (in_array($platform, array('meta', 'chatgpt'), true)) {
            $result['campaignPlatform'] = strtoupper($platform);
        }
        foreach (array('utm_campaign' => 'campaignCode', 'utm_content' => 'adCode') as $key => $field) {
            $value = $values[$key] ?? '';
            if (preg_match('/\A[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}\z/D', $value) === 1) {
                $result[$field] = $value;
            }
        }
        return $result; // No URL, arbitrary query parameters or free text in the signed event.
    }
}

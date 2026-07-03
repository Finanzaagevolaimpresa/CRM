# Integrazione WordPress/WPForms con webhook CRM FAI

Questa guida descrive come collegare i moduli WordPress/WPForms del sito `finanzaagevolaimpresa.it` al webhook CRM FAI già disponibile.

## Obiettivo e perimetro

L'integrazione invia al CRM i lead raccolti dai form WordPress tramite chiamata server-side dal sito WordPress al webhook:

```http
POST /api/integrations/website/leads
```

Il CRM gestisce già:

- header di autenticazione `x-fai-webhook-secret`;
- variabile ambiente CRM `WEBSITE_LEAD_WEBHOOK_SECRET`;
- creazione lead nella pipeline;
- audit log `website_lead_received` e `website_lead_duplicate_detected`;
- deduplica per email/telefono;
- nessuna area cliente pubblica.

In questa fase non devono essere inviati allegati o documenti, non deve essere creata un'area cliente pubblica e il sito WordPress non deve chiamare servizi AI.

## Configurazione server-side WordPress

Definire le costanti nel file `wp-config.php`, preferibilmente sopra la riga `/* That's all, stop editing! Happy publishing. */`.

Produzione/staging con CRM esposto pubblicamente:

```php
define('FAI_CRM_WEBHOOK_URL', 'https://TUO-CRM-DOMINIO/api/integrations/website/leads');
define('FAI_CRM_WEBHOOK_SECRET', 'INSERIRE_SECRET_FORNITO_DAL_TEAM_CRM');
```

Sviluppo locale:

```php
define('FAI_CRM_WEBHOOK_URL', 'http://localhost:3000/api/integrations/website/leads');
define('FAI_CRM_WEBHOOK_SECRET', 'INSERIRE_SECRET_LOCALE');
```

> Nota: `http://localhost:3000` funziona solo se WordPress gira sulla stessa macchina del CRM locale. Dal sito online serve un URL CRM pubblico e raggiungibile da internet, ad esempio `https://crm.example.com/api/integrations/website/leads`.

## Payload JSON atteso dal CRM

Il webhook CRM riceve un JSON con i campi lead normalizzati:

```json
{
  "firstName": "Mario",
  "lastName": "Rossi",
  "companyName": "Rossi Srl",
  "email": "mario.rossi@example.com",
  "phone": "+39 333 1234567",
  "city": "Milano",
  "region": "Lombardia",
  "serviceInterest": "Finanza agevolata",
  "requestedAmount": "50000",
  "message": "Vorrei informazioni su un bando per investimenti produttivi.",
  "sourcePage": "https://finanzaagevolaimpresa.it/contatti/",
  "privacyAccepted": true,
  "marketingAccepted": false
}
```

### Mapping consigliato WPForms → CRM

| Campo modulo WordPress/WPForms | Campo CRM JSON | Note |
| --- | --- | --- |
| Nome | `firstName` | Testo |
| Cognome | `lastName` | Testo |
| Azienda/Ragione sociale | `companyName` | Testo |
| Email | `email` | Email valida |
| Telefono | `phone` | Testo, mantenere prefisso se presente |
| Città | `city` | Testo |
| Regione | `region` | Testo/select |
| Servizio richiesto | `serviceInterest` | Testo/select |
| Importo richiesto/investimento | `requestedAmount` | Testo o numero; evitare simboli non necessari se possibile |
| Messaggio | `message` | Testo libero |
| URL pagina | `sourcePage` | Ricavato server-side/referrer, non serve un campo visibile |
| Privacy | `privacyAccepted` | Booleano; deve essere `true` per lead validi |
| Marketing | `marketingAccepted` | Booleano; facoltativo |

## Snippet PHP per WPCode o plugin custom

Lo snippet seguente usa l'hook `wpforms_process_complete`, legge i campi inviati da WPForms, costruisce il payload JSON e invia una `POST` al CRM con `wp_remote_post`.

> Importante: sostituire gli ID campo nella mappa `$field_map` con gli ID reali dei campi WPForms. Gli ID sono visibili nel builder WPForms cliccando sul singolo campo.

```php
<?php
/**
 * Invia i lead WPForms al webhook CRM FAI.
 * Installazione: WPCode come snippet PHP server-side oppure plugin custom.
 */
add_action('wpforms_process_complete', 'fai_send_wpforms_lead_to_crm', 10, 4);

function fai_send_wpforms_lead_to_crm($fields, $entry, $form_data, $entry_id) {
    if (!defined('FAI_CRM_WEBHOOK_URL') || !defined('FAI_CRM_WEBHOOK_SECRET')) {
        fai_crm_debug_log('Webhook CRM non configurato: costanti mancanti.');
        return;
    }

    // Facoltativo: limitare l'integrazione a uno o più form specifici.
    // Sostituire 123 con l'ID reale del form, oppure rimuovere il blocco per abilitarla su tutti i form.
    $allowed_form_ids = array(123);
    $current_form_id = isset($form_data['id']) ? absint($form_data['id']) : 0;
    if (!empty($allowed_form_ids) && !in_array($current_form_id, $allowed_form_ids, true)) {
        return;
    }

    // Sostituire questi ID con gli ID reali dei campi WPForms.
    $field_map = array(
        'firstName' => 1,
        'lastName' => 2,
        'companyName' => 3,
        'email' => 4,
        'phone' => 5,
        'city' => 6,
        'region' => 7,
        'serviceInterest' => 8,
        'requestedAmount' => 9,
        'message' => 10,
        'privacyAccepted' => 11,
        'marketingAccepted' => 12,
    );

    $payload = array(
        'firstName' => fai_wpforms_field_value($fields, $field_map['firstName']),
        'lastName' => fai_wpforms_field_value($fields, $field_map['lastName']),
        'companyName' => fai_wpforms_field_value($fields, $field_map['companyName']),
        'email' => sanitize_email(fai_wpforms_field_value($fields, $field_map['email'])),
        'phone' => fai_wpforms_field_value($fields, $field_map['phone']),
        'city' => fai_wpforms_field_value($fields, $field_map['city']),
        'region' => fai_wpforms_field_value($fields, $field_map['region']),
        'serviceInterest' => fai_wpforms_field_value($fields, $field_map['serviceInterest']),
        'requestedAmount' => fai_wpforms_field_value($fields, $field_map['requestedAmount']),
        'message' => fai_wpforms_field_value($fields, $field_map['message']),
        'sourcePage' => fai_current_source_page(),
        'privacyAccepted' => fai_wpforms_field_checked($fields, $field_map['privacyAccepted']),
        'marketingAccepted' => fai_wpforms_field_checked($fields, $field_map['marketingAccepted']),
    );

    $payload = array_filter($payload, static function ($value) {
        return $value !== null && $value !== '';
    });

    $response = wp_remote_post(FAI_CRM_WEBHOOK_URL, array(
        'timeout' => 8,
        'redirection' => 0,
        'headers' => array(
            'Content-Type' => 'application/json',
            'Accept' => 'application/json',
            'x-fai-webhook-secret' => FAI_CRM_WEBHOOK_SECRET,
        ),
        'body' => wp_json_encode($payload),
        'data_format' => 'body',
    ));

    if (is_wp_error($response)) {
        fai_crm_debug_log('Errore invio lead CRM: ' . $response->get_error_message());
        return;
    }

    $status_code = (int) wp_remote_retrieve_response_code($response);
    if ($status_code < 200 || $status_code >= 300) {
        fai_crm_debug_log('Webhook CRM ha risposto con status HTTP ' . $status_code . '.');
    }
}

function fai_wpforms_field_value($fields, $field_id) {
    if (!$field_id || !isset($fields[$field_id])) {
        return '';
    }

    $field = $fields[$field_id];
    $value = isset($field['value']) ? $field['value'] : '';

    if (is_array($value)) {
        $value = implode(', ', array_map('sanitize_text_field', $value));
    }

    return sanitize_text_field((string) $value);
}

function fai_wpforms_field_checked($fields, $field_id) {
    if (!$field_id || !isset($fields[$field_id])) {
        return false;
    }

    $value = isset($fields[$field_id]['value']) ? $fields[$field_id]['value'] : '';
    if (is_array($value)) {
        return !empty($value);
    }

    return trim((string) $value) !== '';
}

function fai_current_source_page() {
    if (!empty($_POST['wpforms']['page_url'])) {
        return esc_url_raw(wp_unslash($_POST['wpforms']['page_url']));
    }

    if (!empty($_SERVER['HTTP_REFERER'])) {
        return esc_url_raw(wp_unslash($_SERVER['HTTP_REFERER']));
    }

    return home_url('/');
}

function fai_crm_debug_log($message) {
    if (defined('WP_DEBUG') && WP_DEBUG) {
        // Non loggare mai FAI_CRM_WEBHOOK_SECRET o payload completi con dati sensibili.
        error_log('[FAI CRM webhook] ' . sanitize_text_field($message));
    }
}
```

### Note operative sullo snippet

- Il secret resta sul server WordPress dentro `wp-config.php` e viene inviato solo nell'header HTTP server-to-server `x-fai-webhook-secret`.
- Lo snippet non blocca completamente l'esperienza utente se il CRM non risponde: WPForms completa comunque il submit e l'errore viene loggato solo con `WP_DEBUG` attivo.
- Il timeout consigliato è `8` secondi: abbastanza per una chiamata server-to-server, ma non eccessivo per il submit del form.
- Il blocco `$allowed_form_ids` evita invii accidentali da form non pertinenti. Aggiornare l'ID `123` con l'ID WPForms reale.
- Non includere allegati o documenti nel payload in questa fase.

## Esempio `curl` per test diretto webhook

Sostituire URL e secret con i valori reali dell'ambiente da testare.

```bash
curl -i -X POST 'https://TUO-CRM-DOMINIO/api/integrations/website/leads' \
  -H 'Content-Type: application/json' \
  -H 'x-fai-webhook-secret: INSERIRE_SECRET' \
  --data '{
    "firstName": "Mario",
    "lastName": "Rossi",
    "companyName": "Rossi Srl",
    "email": "mario.rossi@example.com",
    "phone": "+39 333 1234567",
    "city": "Milano",
    "region": "Lombardia",
    "serviceInterest": "Finanza agevolata",
    "requestedAmount": "50000",
    "message": "Vorrei informazioni su un bando per investimenti produttivi.",
    "sourcePage": "https://finanzaagevolaimpresa.it/contatti/",
    "privacyAccepted": true,
    "marketingAccepted": false
  }'
```

## Checklist di test end-to-end

1. Configurare `FAI_CRM_WEBHOOK_URL` e `FAI_CRM_WEBHOOK_SECRET` in `wp-config.php`.
2. Inserire lo snippet in WPCode come snippet PHP server-side oppure in un plugin custom.
3. Aggiornare `$allowed_form_ids` con l'ID WPForms corretto.
4. Aggiornare `$field_map` con gli ID reali dei campi WPForms.
5. Inviare un form WordPress con una nuova email/telefono.
6. Verificare nel CRM che il nuovo lead compaia in `/leads`.
7. Verificare che la fonte del lead sia `Sito web`.
8. Verificare l'audit log `website_lead_received`.
9. Inviare di nuovo lo stesso contatto e verificare che il duplicato venga gestito senza creare lead doppi.
10. Verificare l'audit log `website_lead_duplicate_detected` per il duplicato.
11. Controllare i log WordPress solo se `WP_DEBUG` è attivo e verificare che non contengano il secret.

## Checklist sicurezza

- Non inserire `FAI_CRM_WEBHOOK_SECRET` in JavaScript.
- Non inserire `FAI_CRM_WEBHOOK_SECRET` in HTML, data attribute o campi hidden.
- Non salvare il secret nei log WordPress, nei log CRM o in sistemi di analytics.
- Non inviare allegati o documenti dal sito in questa fase.
- Non creare una nuova area cliente pubblica.
- Non chiamare servizi AI dal sito WordPress.
- Usare HTTPS per l'URL CRM pubblico.
- Ruotare il secret se viene accidentalmente esposto.

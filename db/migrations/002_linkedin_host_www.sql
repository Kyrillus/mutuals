-- Vereinheitlicht den Host bereits gespeicherter LinkedIn-URLs auf www.linkedin.com.
--
-- Hintergrund: lib/queries.ts normalizeLinkedinUrl faltet seit dieser Aenderung
-- jeden linkedin.com-Host (de., uk., m., ohne Subdomain) auf www.linkedin.com.
-- Zeilen, die vorher geschrieben wurden, tragen noch den Originalhost. Ohne
-- diese Migration faende findContactByLinkedinUrl sie nicht mehr: die Suche
-- normalisiert auf www, in der Spalte steht aber 'https://de.linkedin.com/...'.
--
-- Die Spalte hat nach dem Schreiben durch die Query-Schicht immer die Form
-- 'https://<host><pfad>' (Schema klein, ohne Query, ohne Fragment, ohne
-- abschliessenden Slash). Zeilen, die sich nicht als URL parsen liessen und
-- deshalb als Originaltext dastehen, treffen die Bedingung nicht.
--
-- Host und Pfad werden am ersten '/' NACH 'https://' getrennt. Ein blosses
-- LIKE '%.linkedin.com%' waere falsch: es traefe auch
-- 'https://beispiel.de/pfad/x.linkedin.com/y' und wuerde eine fremde URL zu
-- 'https://www.linkedin.com/y' verstuemmeln.
--
-- Der Kniff mit dem angehaengten '/': eine URL ohne Pfad hat keinen Trenner,
-- instr lieferte dort 0 und substr damit Unsinn. Mit dem Sentinel gibt es
-- immer genau einen Trenner, und der Pfadrest ist dann eben leer.
--
-- linkedin_url steht in keiner FTS-Spalte; der Trigger contacts_au baut die
-- betroffenen Indexzeilen also identisch neu auf.

UPDATE contacts
SET linkedin_url =
      'https://www.linkedin.com'
      || substr(
           substr(linkedin_url, 9),
           instr(substr(linkedin_url, 9) || '/', '/')
         )
WHERE linkedin_url LIKE 'https://%'
  AND substr(
        substr(linkedin_url, 9),
        1,
        instr(substr(linkedin_url, 9) || '/', '/') - 1
      ) <> 'www.linkedin.com'
  AND (
        substr(
          substr(linkedin_url, 9),
          1,
          instr(substr(linkedin_url, 9) || '/', '/') - 1
        ) = 'linkedin.com'
        OR substr(
             substr(linkedin_url, 9),
             1,
             instr(substr(linkedin_url, 9) || '/', '/') - 1
           ) LIKE '%.linkedin.com'
      );

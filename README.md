# ZHA Network Card

Grafische Zigbee-Mesh-Visualisierung für Home Assistant Dashboards – als Ersatz für die interne (nicht einbettbare) Seite `/config/zha/visualization`.

Die Karte nutzt **ausschließlich die bereits in ZHA eingebauten Websocket-Befehle** (`zha/devices`, `zha/topology/update`). Es ist **keine eigene Integration / kein `custom_component`** nötig – nur diese eine JavaScript-Datei.

## Funktionen

- Koordinator (Rechteck), Router (Oval), Endgeräte (Kreis) als Knoten
- Verbindungslinien farbcodiert nach LQI (Link Quality Index):
  - 🟢 Grün: LQI > 192
  - 🟡 Gelb: LQI 129–192
  - 🔴 Rot: LQI ≤ 128
- Klick auf ein Gerät zeigt Details (IEEE, NWK, Hersteller, Modell, RSSI, LQI, Online-Status, zuletzt gesehen)
- Zoom (Mausrad) & Pan (Ziehen)
- Roter Punkt am Knoten = Gerät aktuell offline
- "Rescan"-Button stößt einen frischen ZHA-Netzwerk-Scan an (`zha/topology/update`) und lädt danach automatisch neu
- Automatische periodische Aktualisierung (konfigurierbar)
- Layout läuft lokal im Browser (Force-Directed-Algorithmus), keine externen Abhängigkeiten

## Installation (HACS)

1. HACS → Frontend → ⋮ → Benutzerdefinierte Repositories
2. Repository: `https://github.com/Noack1978/ha-zha-network-card`, Kategorie: **Lovelace**
3. Installieren, danach Browser-Cache leeren / HA neu laden

## Installation (manuell)

1. `zha-network-card.js` nach `/config/www/zha-network-card/` kopieren
2. Einstellungen → Dashboards → Ressourcen → Ressource hinzufügen:
   - URL: `/local/zha-network-card/zha-network-card.js`
   - Typ: JavaScript-Modul

## Verwendung

Da du `type: sections` für deine Dashboards nutzt, einfach als Karte in eine Section einfügen:

```yaml
type: custom:zha-network-card
title: ZHA Netzwerk
refresh_interval: 60      # Sekunden, 0 = kein Auto-Refresh
rescan_on_load: false     # true = bei jedem Laden sofort neu scannen
show_end_devices: true    # false = nur Koordinator + Router anzeigen
height: 560                # Höhe der Karte in px
link_mode: routes          # "routes" (Standard) = nur aktive Routing-Pfade
                            # "neighbors" = alle gehörten Nachbarn (mehr Linien)
```

**Zu `link_mode`:**
- `routes` (Standard): zeigt pro Gerät nur die Verbindung, über die es laut ZHA-Routingtabelle tatsächlich aktuell sendet (`next_hop`). Deutlich übersichtlicher, entspricht dem real genutzten Pfad.
- `neighbors`: zeigt jede gehörte Nachbarschaftsbeziehung (Mgmt_Lqi-Tabelle) – nützlich, um mögliche Ausweich-/Backup-Pfade zu sehen, aber unübersichtlicher.

## Voraussetzungen

- Home Assistant mit aktiver **ZHA**-Integration
- Der aufrufende Benutzer benötigt **Admin-Rechte** (die ZHA-Websocket-Befehle erfordern `require_admin`)

## Hinweise

- Neue Verbindungslinien/Nachbarn entstehen erst nach einem Netzwerk-Scan. ZHA führt diesen periodisch selbst aus; über den Rescan-Button kann er manuell angestoßen werden.
- Fehlende Linien zu batteriebetriebenen Endgeräten (Sleepy End Devices) sind normal und kein Fehlerzeichen.
- Basiert auf der von Home Assistant Core bereitgestellten ZHA-Websocket-API (`homeassistant/components/zha/websocket_api.py`, `helpers.py`). Da diese API-Befehle Teil von HA-Core selbst sind (nicht deprecated), ist die Karte unabhängig von den eingestellten Community-Karten `zha-network-visualization-card` / `zha-map`.

## Lizenz

MIT

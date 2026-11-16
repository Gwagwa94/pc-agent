# Spécification Technique & Architecture du Système : Agent PC Autonome "Dual-Brain" (Windows 11 + LM Studio + MCP + WireGuard)

> **Note de contexte pour l'assistant IA (Antigravity) :**  
> Ce document décrit l'architecture complète, les choix matériels/logiciels, les contournements techniques Windows 11 et le flux d'exécution de l'agent autonome local de Grégoire. Utilise ce document comme **source de vérité absolue** pour générer, modifier ou déployer des scripts tant sur le **PC Windows 11 (Hôte Exécutant)** que sur le **Serveur distant / VPS (Orchestrateur amont)**.

---

## 1. Vue d'Ensemble & Topologie Réseau

L'objectif du projet est de permettre le contrôle total et autonome d'un PC sous **Windows 11** à partir d'instructions en langage naturel (envoyées depuis une interface Web locale ou depuis un serveur distant via un tunnel VPN privé **WireGuard**), en utilisant exclusivement une **inférence locale gratuite** sur GPU/RAM grand public, sans dépendre d'API payantes.

### 1.1. Matériel de l'Hôte Windows 11 (`pc-agent`)
* **OS :** Windows 11 (64-bit)
* **Utilisateur / Répertoire racine :** `C:\Users\grego\pc-agent\`
* **GPU :** NVIDIA GeForce RTX 4060 (**8 Go de VRAM** dédiée)
* **RAM Système :** **32 Go DDR4/DDR5** (essentiel pour le cache de fichiers `.gguf` en mémoire vive Windows et l'offload hybride MoE)
* **Stockage :** SSD NVMe
* **Résolution d'écran principale :** `1920x1080` (détectée dynamiquement au démarrage et vérifiée dans les en-têtes binaires PNG de chaque capture d'écran)

### 1.2. Topologie Réseau & Ports
```
[Serveur Distant / VPS / Mobile] (10.7.0.1)
       │
       │  Tunnel VPN WireGuard chiffré
       ▼
[PC Windows 11 — IP WireGuard : 10.7.0.2 / Localhost : 127.0.0.1]
       ├── Port 2999 (Node.js / Express : `agent.ts` + `dashboard.html`)
       │     ├── GET  /             -> Interface Web de contrôle (`dashboard.html`)
       │     ├── GET  /status       -> État temps réel (busy, logs, dimensions, timestamp snapshot)
       │     ├── GET  /snapshot.png -> Dernière capture d'écran vue par l'agent (`last_snapshot.png`)
       │     └── POST /command      -> Point d'entrée JSON `{"instruction": "..."}`
       │
       ├── Port 1234 (LM Studio Server — API compatible OpenAI `/v1/chat/completions`)
       │     └── Piloté dynamiquement via CLI `lms.exe` (`lms unload --all` / `lms load ...`)
       │
       ├── Sous-processus STDIO : `uvx.exe windows-mcp serve` (Serveur MCP Python d'interaction Windows)
       │
       └── Port 9222 (Optionnel : Google Chrome avec `--remote-debugging-port=9222` pour Playwright CDP)
```

---

## 2. Architecture Cognitive "Dual-Brain" & Swap VRAM / RAM

### 2.1. Pourquoi une architecture à deux cerveaux ?
Une carte graphique de **8 Go de VRAM** (RTX 4060) ne peut pas faire tourner simultanément un grand modèle de raisonnement et un modèle de vision GUI haute précision. De plus :
* Les modèles excellents en **planification/logique** sont souvent médiocres pour estimer des coordonnées spatiales `(x, y)` sur une capture d'écran.
* Les modèles entraînés spécifiquement pour le **clic GUI** (comme `UI-TARS`) sont petits (7B) et peuvent tourner en boucle sur des tâches multi-étapes s'ils ne sont pas supervisés.

La solution implémentée dans `agent.ts` est une boucle **Orchestrateur / Exécutant (*Planner / Grounder*)** avec **Swap dynamique de la VRAM** piloté par la CLI de LM Studio (`lms.exe`), en s'appuyant sur les **32 Go de RAM système** comme tampon ultra-rapide (OS File Cache Windows).

### 2.2. Les Deux Modèles Utilisés (Configuration actuelle)

| Rôle dans `agent.ts` | Modèle utilisé dans LM Studio | Quantisation actuelle | Poids total (Modèle + Vision `mmproj`) | Mode de chargement (`lms load`) | Rôle précis |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. Le Stratège (`PLANNER_MODEL`)** | **`Gemma-4-26B-A4B-it-QAT`** *(Architecture MoE : 26B totaux, seulement **3,8B actifs** par token)* | **`Q4 QAT`** *(Quantization-Aware Training par Google)* | **~15,5 Go** | **Hybride VRAM + RAM** (`lms load "gemma-4-26b-a4b" -y` sans `--gpu max`) | Analyse la capture d'écran, vérifie si l'objectif est atteint (`DONE`/`FAILED`/`CONTINUE`), rédige la sous-tâche précise, **filtre la liste d'outils autorisés** (`allowed_tools`) et fixe le **budget d'étapes** (`max_steps`). |
| **2. L'Exécutant (`EXECUTOR_MODEL`)** | **`ByteDance UI-TARS-1.5-7B`** *(Spécialiste natif GUI / Computer Use)* | **`Q4_K_M`** *(actuel — évolutif vers `Q5_K_M`)* | **~5,6 Go** (`4,5 Go` modèle + `1,1 Go` vision) | **100 % VRAM GPU** (`lms load "ui-tars-1.5-7b" --gpu max -y`) | Reçoit uniquement la sous-tâche du Stratège et les outils autorisés. Exécute les clics (`ClickPerMille` / `Click`), les frappes clavier (`TypeRaw`) et rend la main au Stratège. |

### 2.3. Mécanique du Swap Rapide grâce aux 32 Go de RAM
1. Lors du premier chargement, Windows 11 met en cache les fichiers `.gguf` (`~15,5 Go + ~5,6 Go = ~21,1 Go`) dans la mémoire vive libre (**RAM Standby List** sur les 32 Go).
2. Lorsque `agent.ts` exécute `lms unload --all` puis `lms load ...`, LM Studio ne relit **pas** le SSD NVMe : il copie les poids directement depuis la RAM DDR4/DDR5 vers la VRAM de la RTX 4060 via le bus PCIe ($\approx 12\text{ à }16\text{ Go/s}$).
3. Un cycle complet comporte au maximum **4 allers-retours Stratège $\leftrightarrow$ Exécutant**.

---

## 3. Flux d'Exécution Détaillé d'une Requête (`runAgentTask`)

Lorsqu'une requête HTTP `POST /command` contenant `{"instruction": "..."}` arrive sur le port `2999` :

### Étape 0 : Prise d'état initiale (`takeFreshSnapshot`)
* Le script interroge l'API Win32 (`user32.dll` -> `GetForegroundWindow` + `GetWindowText`) via PowerShell pour connaître avec certitude le titre exact de la fenêtre au premier plan.
* Il appelle l'outil MCP `Snapshot { use_vision: true }` de `windows-mcp`.
* Il lit les octets `16..24` du buffer PNG retourné pour mettre à jour `screenDimensions = { width, height }`, sauvegarde `last_snapshot.png` sur le disque, et prépare l'image en Base64.

### Phase 1 : Consultation du Stratège (`askPlanner`)
1. `swapVramModel(PLANNER_MODEL, 'STRATÈGE 🧠')` charge **Gemma 4 26B-A4B QAT**.
2. Le Stratège reçoit :
   * L'objectif global de l'utilisateur (`userGoal`).
   * L'historique résumé des cycles précédents (`executionHistory`).
   * La capture d'écran actuelle + l'arbre UIA (`Interactive Elements`) + le titre de la fenêtre active.
3. Le Stratège répond **strictement en JSON** :
   ```json
   {
     "status": "CONTINUE",
     "thought": "Gmail n'est pas encore ouvert, l'écran affiche le Dashboard.",
     "subtask_instruction": "Utilise ComposeGmail pour rédiger et envoyer l'email test à gregoirebaumann94@gmail.com.",
     "allowed_tools": ["ComposeGmail", "Shortcut"],
     "max_steps": 2,
     "final_response": ""
   }
   ```
4. Si `status === "DONE"` ou `"FAILED"`, la boucle s'arrête immédiatement et renvoie `final_response` au client HTTP.

### Phase 2 : Exécution Verrouillée par l'Exécutant (`runExecutorSubtask`)
1. `swapVramModel(EXECUTOR_MODEL, 'EXÉCUTANT 🛠️')` décharge Gemma et charge **UI-TARS-1.5-7B (`Q4_K_M`)** à 100 % dans la VRAM (`--gpu max`).
2. `agent.ts` **filtre physiquement le tableau `tools`** passé à l'API OpenAI de LM Studio pour ne garder que `decision.allowed_tools`. L'Exécutant est donc techniquement incapable d'appeler un outil non autorisé par le Stratège.
3. L'Exécutant dispose d'une boucle bornée à `decision.max_steps` (entre 1 et 8 étapes).
4. **Après chaque appel d'outil**, `agent.ts` :
   * Attend la stabilisation de l'interface (`sleep`).
   * Prend **automatiquement un nouveau `Snapshot`** frais.
   * Purge les anciennes images de la fenêtre de contexte (`pruneOldSnapshots` ne garde que les 2 dernières images et le dernier arbre textuel) pour éviter la saturation de la VRAM et les confusions de labels.
5. Dès que l'Exécutant répond `[SOUS-TÂCHE TERMINÉE]` ou atteint `max_steps`, il rend la main au Stratège (retour en Phase 1 avec le dernier `Snapshot` et le journal des actions exécutées).

---

## 4. Catalogue des Outils & Contournements Techniques Windows 11

L'utilisation brute de `windows-mcp` présentait plusieurs limitations majeures sur Windows 11. `agent.ts` encapsule et remplace les outils défaillants par des **Super-Outils déterministes** :

### 4.1. Tableau des Outils Exposés

| Nom de l'outil | Origine | Description & Fonctionnement interne |
| :--- | :--- | :--- |
| **`ClickPerMille`** | Custom (`agent.ts`) | **Remplace les clics en pixels ou en pourcentages.** Reçoit `x_permille` ($0\text{ à }1000\text{‰}$) et `y_permille` ($0\text{ à }1000\text{‰}$). Convertit en pixels réels via $\text{round}\left(\frac{x}{1000} \times \text{width}\right)$ et appelle `Click { loc: [x_px, y_px] }`. Pourquoi en pour mille ? Parce que les encodeurs visuels Qwen/UI-TARS utilisent nativement une grille normalisée $[0, 1000]$. |
| **`Click`** | `windows-mcp` | Utilisé lorsqu'un élément natif Windows possède un numéro de `label` exact dans la liste `Interactive Elements` du dernier `Snapshot`. |
| **`TypeRaw`** | Custom (`agent.ts`) | **Remplace l'outil `Type` de `windows-mcp`** (qui crashait avec `ValueError: Either loc or label must be provided` et plantait sur les sauts de ligne `\n` ou apostrophes). Encode le texte en UTF-8 Base64, lance PowerShell avec `-EncodedCommand` (UTF-16LE), copie le texte dans le presse-papiers (`Set-Clipboard`), simule `Ctrl+V` (`^v`), puis optionnellement `{ENTER}` (`press_enter`) et `{TAB}` (`press_tab`). |
| **`OpenUrlInChrome`** | Custom (`agent.ts`) | Ouvre directement une URL dans la fenêtre Chrome existante (`Start-Process "chrome.exe" -ArgumentList $url`) sans que l'agent ait besoin de chercher l'icône Chrome ou la barre d'adresse. |
| **`ComposeGmail`** | Custom (`agent.ts`) | Ouvre directement l'URL d'écriture Gmail pré-remplie (`https://mail.google.com/mail/?view=cm&fs=1&to=...&su=...&body=...`), attend $4,5\text{ s}$ le chargement du DOM Gmail, et envoie `Ctrl+Entrée` (`^{ENTER}`) pour expédier l'email. |
| **`Shortcut`** | Hybride (`agent.ts` + MCP) | Intercepte les raccourcis critiques (`ctrl+enter`, `ctrl+w`, `ctrl+t`, `ctrl+l`, `ctrl+tab`, `enter`, `tab`, `esc`) via `System.Windows.Forms.SendKeys::SendWait` pour garantir leur exécution sur Chrome, sinon délègue à `windows-mcp`. |
| **`Scroll`** | `windows-mcp` | Défilement vertical/horizontal. |
| **`App`** | `windows-mcp` | Lance ou bascule (`switch`) vers une application Windows. |
| **`PowerShell`** | `windows-mcp` | Exécute une commande système Windows en arrière-plan. |
| **`ask_gemini_web`** | Custom (Playwright CDP) | Se connecte au port `9222` de Chrome via Playwright CDP pour interagir avec un onglet `gemini.google.com` si besoin. |

### 4.2. Contraintes de Sécurité Windows 11 (UIPI)
* **Droits Administrateur obligatoires pour les fenêtres système :** Sous Windows 11, l'*User Interface Privilege Isolation (UIPI)* bloque silencieusement tout événement souris/clavier synthétique envoyé par un processus non-élevé vers une fenêtre élevée (ex: Gestionnaire des tâches `Taskmgr.exe`, installateurs UAC).
* **Règle de déploiement :** Le processus Node.js (`npx tsx agent.ts` ou le service PM2/Tâche planifiée) **doit impérativement être exécuté en tant qu'Administrateur**.

---

## 5. Structure des Fichiers du Projet (`C:\Users\grego\pc-agent\`)

```
C:\Users\grego\pc-agent\
├── .env                  # Variables d'environnement (URLs, noms des modèles Stratège/Exécutant, ports)
├── package.json          # Dépendances Node.js (express, openai, @modelcontextprotocol/sdk, playwright-core, dotenv, tsx)
├── agent.ts              # Serveur Express + Orchestrateur Dual-Brain + Pont MCP + Swap VRAM
├── dashboard.html        # Interface Web Temps Réel (Chat, Raccourcis, Aperçu Snapshot Live, Logs d'outils)
└── last_snapshot.png     # Généré automatiquement à chaque étape pour le suivi visuel
```

### Configuration `.env` de référence
```env
PORT=2999
BIND_HOST=0.0.0.0
LM_STUDIO_URL=http://127.0.0.1:1234/v1

# Cerveau 1 : Le Stratège (MoE Hybride VRAM + 32Go RAM)
PLANNER_MODEL=gemma-4-26b-a4b-it-qat

# Cerveau 2 : L'Exécutant GUI (100% VRAM RTX 4060 - actuellement en Q4_K_M)
EXECUTOR_MODEL=ui-tars-1.5-7b

# Optionnel : Pont Chrome CDP
CHROME_CDP_URL=http://127.0.0.1:9222
```

---

## 6. Guide de Déploiement Automatisé (Instructions pour Antigravity)

### 6.1. Prérequis sur le PC Windows 11 (`10.7.0.2`)
1. **Outil `uv` / `uvx` installé :**
   * Chemin binaire attendu : `C:\Users\grego\.local\bin\uvx.exe`
   * Pré-cache du serveur MCP : `C:\Users\grego\.local\bin\uvx.exe windows-mcp serve`
2. **LM Studio & CLI `lms` actifs :**
   * Binaire CLI attendu : `C:\Users\grego\.lmstudio\bin\lms.exe`
   * Serveur local LM Studio démarré sur le port `1234` (`lms server start --port 1234`).
   * Vérifier les identifiants exacts des modèles téléchargés avec `lms ls` et ajuster `PLANNER_MODEL` et `EXECUTOR_MODEL` dans `.env`.
   * **Important :** Dans LM Studio, désactiver tout serveur MCP interne (`mcp.json` vide dans LM Studio) afin que seul `agent.ts` pilote `windows-mcp` sans conflit de processus.
3. **Lancement du serveur `agent.ts` (en Administrateur) :**
   ```powershell
   cd C:\Users\grego\pc-agent
   npx tsx agent.ts
   ```
   *(Pour une mise en production permanente au démarrage de Windows, créer une tâche planifiée Windows avec privilèges maximaux `RunLevel Highest` ou utiliser `pm2` dans un terminal Administrateur).*

### 6.2. Intégration côté Serveur Distant / VPS (`10.7.0.1` via WireGuard)
Le serveur distant peut piloter le PC Windows 11 de Grégoire en effectuant de simples appels HTTP sur l'IP WireGuard du PC (`10.7.0.2:2999`) :

* **Envoyer un ordre à l'Agent PC depuis le serveur :**
  ```bash
  curl -X POST http://10.7.0.2:2999/command \
    -H "Content-Type: application/json" \
    -d '{"instruction": "Envoie un email de test à gregoirebaumann94@gmail.com"}'
  ```
* **Suivre l'état d'avancement et les logs depuis le serveur :**
  ```bash
  curl -s http://10.7.0.2:2999/status | jq .
  ```
* **Récupérer la capture d'écran actuelle du PC :**
  ```bash
  curl -s http://10.7.0.2:2999/snapshot.png --output current_screen.png
  ```

### 6.3. Pare-feu Windows (Autorisation du port 2999 sur WireGuard)
Si le serveur distant (`10.7.0.1`) ne parvient pas à joindre `10.7.0.2:2999`, exécuter une seule fois dans PowerShell (Administrateur) sur le PC Windows :
```powershell
New-NetFirewallRule -DisplayName "PC-Agent-MCP-2999" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 2999
```

---

## 7. Évolutions Prévues (Roadmap Technique)
1. **Passage optionnel de `UI-TARS-1.5-7B` de `Q4_K_M` à `Q5_K_M` :** Dès que souhaité, remplacer le fichier `.gguf` de l'Exécutant par la version `Q5_K_M` (`~5,4 Go` + `1,1 Go` `mmproj` = `~6,5 Go` en VRAM) sans aucune modification de code (seul `EXECUTOR_MODEL` dans `.env` est mis à jour si le nom du fichier change).
2. **File d'attente asynchrone (Job Queue) :** Actuellement, `POST /command` maintient la connexion HTTP ouverte jusqu'à la fin des cycles (réponse synchrone). Si le serveur distant envoie des tâches longues ($> 2\text{ minutes}$), `POST /command` pourra renvoyer un `job_id` immédiat pendant que le serveur interroge `GET /status`.
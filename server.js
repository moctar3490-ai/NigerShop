// ============================================================
// NigerShop — Backend Node.js + SQLite (version corrigée)
// Dépendances : npm install express@4 sqlite3 bcryptjs jsonwebtoken multer nodemailer cors dotenv
// ============================================================

require('dotenv').config();

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-moi-secret-par-defaut';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@nigershop.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ---------- TRANSPORTEUR EMAIL ----------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS
  }
});

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Dossier uploads
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Fichiers statiques (HTML, CSS, JS client)
app.use(express.static(__dirname));

// ---------- UPLOAD MULTER ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) =>
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Seules les images sont autorisées'));
  }
});

// ---------- BASE DE DONNÉES ----------
const db = new sqlite3.Database('nigershop.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT,
    email TEXT UNIQUE,
    password_hash TEXT,
    telephone TEXT,
    ville TEXT,
    role TEXT DEFAULT 'client',
    verifie INTEGER DEFAULT 0,
    code_parrain TEXT UNIQUE,
    parrain_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS produits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT,
    description TEXT,
    prix REAL,
    stock INTEGER DEFAULT 0,
    categorie TEXT,
    vendeur_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

      // Migration : ajouter la colonne ancien_prix si elle n'existe pas
  db.run(`ALTER TABLE produits ADD COLUMN ancien_prix REAL`, err => {
    // Erreur "duplicate column" = normal si la colonne existe déjà
    if (err && !err.message.includes('duplicate column')) {
      console.log('ℹ️  Colonne ancien_prix déjà présente');
    }
  });

  db.run(`CREATE TABLE IF NOT EXISTS produit_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produit_id INTEGER,
    url TEXT,
    ordre INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS commentaires (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produit_id INTEGER,
    user_id INTEGER,
    note INTEGER,
    texte TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS favoris (
    user_id INTEGER,
    produit_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, produit_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS historique (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    produit_id INTEGER,
    action TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS commandes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    total REAL,
    transport TEXT,
    paiement TEXT,
    ville_livraison TEXT,
    telephone TEXT,
    statut TEXT DEFAULT 'en_attente',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
    // Migration : colonnes promo dans commandes
  db.run(`ALTER TABLE commandes ADD COLUMN code_promo TEXT`, () => {});
  db.run(`ALTER TABLE commandes ADD COLUMN remise REAL DEFAULT 0`, () => {});

  db.run(`CREATE TABLE IF NOT EXISTS commande_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    commande_id INTEGER,
    produit_id INTEGER,
    nom TEXT,
    qty INTEGER,
    prix REAL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    expediteur_id INTEGER,
    destinataire_id INTEGER,
    produit_id INTEGER,
    contenu TEXT,
    lu INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS commissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    commande_id INTEGER,
    montant REAL,
    niveau INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
    db.run(`CREATE TABLE IF NOT EXISTS codes_promo (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE,
    type TEXT,
    valeur REAL,
    min_commande REAL DEFAULT 0,
    actif INTEGER DEFAULT 1,
    date_expiration DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS codes_promo_utilisations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_id INTEGER,
    user_id INTEGER,
    commande_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Création de l'admin par défaut si aucun utilisateur
  db.get('SELECT COUNT(*) as c FROM users', async (e, r) => {
    if (e) {
      console.error('❌ Erreur DB au démarrage:', e.message);
      return;
    }
    if (r && r.c === 0) {
      try {
        const hash = await bcrypt.hash(ADMIN_PASSWORD, 10);
        db.run(
          `INSERT INTO users (nom,email,password_hash,role,verifie,code_parrain)
           VALUES (?,?,?,?,1,?)`,
          ['Administrateur', ADMIN_EMAIL, hash, 'admin', 'ADMIN001'],
          function (err) {
            if (err) {
              console.error('❌ Erreur création admin:', err.message);
            } else {
              console.log('✅ Admin créé :', ADMIN_EMAIL, '/', ADMIN_PASSWORD);
            }
          }
        );
      } catch (err) {
        console.error('❌ Erreur hash admin:', err.message);
      }
    } else {
      console.log('ℹ️  Base existante —', r.c, 'utilisateur(s)');
    }
  });
});

// ---------- HELPERS ----------
const auth = (req, res, next) => {
  const t = req.headers.authorization?.split(' ')[1];
  if (!t) return res.status(401).json({ message: 'Non authentifié' });
  try {
    req.user = jwt.verify(t, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Token invalide' });
  }
};

const adminOnly = (req, res, next) =>
  req.user && req.user.role === 'admin'
    ? next()
    : res.status(403).json({ message: 'Accès refusé' });

function genCodeParrain(nom) {
  return nom.slice(0, 3).toUpperCase() + Math.floor(1000 + Math.random() * 9000);
}

// ============================================================
// ROUTES API
// ============================================================

// ---------- AUTH ----------
app.post('/api/register', async (req, res) => {
  const { nom, email, mot_de_passe, telephone, ville, role, code_parrain_utilise } = req.body;
  if (!nom || !email || !mot_de_passe)
    return res.status(400).json({ message: 'Champs requis manquants' });

  db.get('SELECT id FROM users WHERE email=?', [email], async (e, ex) => {
    if (e) return res.status(500).json({ message: 'Erreur DB' });
    if (ex) return res.status(400).json({ message: 'Email déjà utilisé' });

    try {
      const hash = await bcrypt.hash(mot_de_passe, 10);
      let parrain_id = null;

      if (code_parrain_utilise) {
        parrain_id = await new Promise(r =>
          db.get('SELECT id FROM users WHERE code_parrain=?',
            [code_parrain_utilise], (e, x) => r(x ? x.id : null)));
      }

      const code = genCodeParrain(nom);

      db.run(
        `INSERT INTO users (nom,email,password_hash,telephone,ville,role,code_parrain,parrain_id)
         VALUES (?,?,?,?,?,?,?,?)`,
        [nom, email, hash, telephone || '', ville || '', role || 'client', code, parrain_id],
        function (err) {
          if (err) return res.status(500).json({ message: 'Erreur création' });
          res.json({ id: this.lastID, code_parrain: code });
        }
      );
    } catch (err) {
      res.status(500).json({ message: 'Erreur serveur' });
    }
  });
});

app.post('/api/login', (req, res) => {
  const { email, mot_de_passe } = req.body;
  db.get('SELECT * FROM users WHERE email=?', [email], async (e, u) => {
    if (e) return res.status(500).json({ message: 'Erreur DB' });
    if (!u) return res.status(400).json({ message: 'Utilisateur inconnu' });

    const ok = await bcrypt.compare(mot_de_passe, u.password_hash);
    if (!ok) return res.status(400).json({ message: 'Mot de passe incorrect' });

    const token = jwt.sign(
      { id: u.id, email: u.email, role: u.role, nom: u.nom },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      token,
      user: {
        id: u.id, nom: u.nom, email: u.email, role: u.role,
        verifie: u.verifie, code_parrain: u.code_parrain
      }
    });
  });
});

// ---------- PRODUITS ----------
app.get('/api/produits', (req, res) => {
  db.all('SELECT * FROM produits ORDER BY created_at DESC', (e, rows) => {
    if (e) return res.status(500).json({ message: 'Erreur' });
    if (!rows) return res.json([]);

    const promises = rows.map(p => new Promise(resolve => {
      db.all('SELECT id, url FROM produit_images WHERE produit_id=? ORDER BY ordre',
        [p.id], (e2, imgs) => {
          p.images = (imgs || []).map(i => i.url);
          db.get(
            `SELECT AVG(note) as moy, COUNT(*) as nb FROM commentaires WHERE produit_id=?`,
            [p.id], (e3, st) => {
              p.note_moyenne = st?.moy || 0;
              p.nb_avis = st?.nb || 0;
              resolve(p);
            });
        });
    }));
    Promise.all(promises).then(list => res.json(list));
  });
});

app.get('/api/produits/:id', (req, res) => {
  db.get('SELECT * FROM produits WHERE id=?', [req.params.id], (e, p) => {
    if (e) return res.status(500).json({ message: 'Erreur' });
    if (!p) return res.status(404).json({ message: 'Introuvable' });

    db.all('SELECT id, url FROM produit_images WHERE produit_id=? ORDER BY ordre',
      [p.id], (e2, imgs) => {
        p.images = (imgs || []).map(i => i.url);
        db.all(
          `SELECT c.*, u.nom as user_nom FROM commentaires c
           JOIN users u ON u.id=c.user_id
           WHERE c.produit_id=? ORDER BY c.created_at DESC`,
          [p.id], (e3, comms) => {
            p.commentaires = comms || [];
            res.json(p);
          });
      });
  });
});

app.post('/api/produits', auth, adminOnly, upload.array('images', 10), (req, res) => {
    const { nom, description, prix, ancien_prix, stock, categorie } = req.body;
  if (!nom || !prix) return res.status(400).json({ message: 'Nom et prix requis' });

  db.run(
      `INSERT INTO produits (nom,description,prix,ancien_prix,stock,categorie,vendeur_id)
          VALUES (?,?,?,?,?,?,?)`,
     [nom, description || '', prix, ancien_prix || null, stock || 0, categorie || 'Divers', req.user.id],
    function (err) {
      if (err) return res.status(500).json({ message: 'Erreur' });
      const pid = this.lastID;
      if (req.files && req.files.length) {
        req.files.forEach((f, i) => {
          db.run('INSERT INTO produit_images (produit_id,url,ordre) VALUES (?,?,?)',
            [pid, '/uploads/' + f.filename, i]);
        });
      }
      res.json({ id: pid });
    }
  );
});

app.put('/api/produits/:id', auth, adminOnly, upload.array('images', 10), (req, res) => {
  const { nom, description, prix, ancien_prix, stock, categorie } = req.body;

  db.run(
    `UPDATE produits SET nom=?, description=?, prix=?, ancien_prix=?, stock=?, categorie=? WHERE id=?`,
    [nom, description, prix, ancien_prix || null, stock, categorie, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ message: 'Erreur mise à jour' });

      // Si de nouvelles images sont envoyées, on REMPLACE les anciennes
      if (req.files && req.files.length > 0) {
        db.run('DELETE FROM produit_images WHERE produit_id=?', [req.params.id], () => {
          req.files.forEach((f, i) => {
            db.run(
              'INSERT INTO produit_images (produit_id,url,ordre) VALUES (?,?,?)',
              [req.params.id, '/uploads/' + f.filename, i]
            );
          });
        });
      }

      res.json({ ok: true });
    }
  );
});

app.delete('/api/produits/:id', auth, adminOnly, (req, res) => {
  db.run('DELETE FROM produits WHERE id=?', [req.params.id], err =>
    err ? res.status(500).json({ message: 'Erreur' }) : res.json({ ok: true }));
});

app.post('/api/produits/:id/images', auth, adminOnly, upload.array('images', 10), (req, res) => {
  const pid = req.params.id;
  if (!req.files || !req.files.length) return res.status(400).json({ message: 'Aucune image' });
  req.files.forEach((f, i) => {
    db.run('INSERT INTO produit_images (produit_id,url,ordre) VALUES (?,?,?)',
      [pid, '/uploads/' + f.filename, i]);
  });
  res.json({ ok: true });
});

app.delete('/api/images/:id', auth, adminOnly, (req, res) => {
  db.run('DELETE FROM produit_images WHERE id=?', [req.params.id], err =>
    err ? res.status(500).json({ message: 'Erreur' }) : res.json({ ok: true }));
});

// ---------- COMMENTAIRES ----------
app.post('/api/produits/:id/commentaires', auth, (req, res) => {
  const { note, texte } = req.body;
  if (!note || !texte) return res.status(400).json({ message: 'Note et texte requis' });

  db.run('INSERT INTO commentaires (produit_id,user_id,note,texte) VALUES (?,?,?,?)',
    [req.params.id, req.user.id, note, texte],
    function (err) {
      if (err) return res.status(500).json({ message: 'Erreur' });
      res.json({ id: this.lastID });
    });
});

// ---------- FAVORIS ----------
app.post('/api/favoris/:pid', auth, (req, res) => {
  db.run('INSERT OR IGNORE INTO favoris (user_id,produit_id) VALUES (?,?)',
    [req.user.id, req.params.pid], () => res.json({ ok: true }));
});

app.delete('/api/favoris/:pid', auth, (req, res) => {
  db.run('DELETE FROM favoris WHERE user_id=? AND produit_id=?',
    [req.user.id, req.params.pid], () => res.json({ ok: true }));
});

app.get('/api/favoris', auth, (req, res) => {
  db.all(
    `SELECT p.* FROM favoris f JOIN produits p ON p.id=f.produit_id
     WHERE f.user_id=?`,
    [req.user.id], (e, rows) => res.json(rows || []));
});

// ---------- HISTORIQUE ----------
app.post('/api/historique', auth, (req, res) => {
  const { produit_id, action } = req.body;
  db.run('INSERT INTO historique (user_id,produit_id,action) VALUES (?,?,?)',
    [req.user.id, produit_id, action]);
  res.json({ ok: true });
});

app.get('/api/historique', auth, (req, res) => {
  db.all(
    `SELECT h.*, p.nom as produit_nom FROM historique h
     LEFT JOIN produits p ON p.id=h.produit_id
     WHERE h.user_id=? ORDER BY h.created_at DESC LIMIT 50`,
    [req.user.id], (e, rows) => res.json(rows || []));
});

// ---------- COMMANDES ----------
app.post('/api/commandes', auth, (req, res) => {
    const { total, transport, paiement, ville_livraison, telephone, articles, code_promo } = req.body;
  if (!articles || !articles.length)
    return res.status(400).json({ message: 'Panier vide' });

  db.run(
    `INSERT INTO commandes (user_id,total,transport,paiement,ville_livraison,telephone,code_promo,remise)
         VALUES (?,?,?,?,?,?,?,?)`,
    [req.user.id, total, transport, paiement, ville_livraison, telephone, code_promo || null, 0],
    
    function (err) {
      if (err) return res.status(500).json({ message: 'Erreur' });
      const cid = this.lastID;
              // Enregistrer l'utilisation du code promo
      if (code_promo) {
        db.get('SELECT id FROM codes_promo WHERE code=?', [code_promo], (e, cp) => {
          if (cp) {
            db.run(
              `INSERT INTO codes_promo_utilisations (code_id,user_id,commande_id)
               VALUES (?,?,?)`,
              [cp.id, req.user.id, cid]);
          }
        });
      }
      // Lignes de commande
      const stmt = db.prepare(
        `INSERT INTO commande_items (commande_id,produit_id,nom,qty,prix) VALUES (?,?,?,?,?)`
      );
      articles.forEach(a => stmt.run(cid, a.id, a.nom, a.qty, a.prix));
      stmt.finalize();

      // Commissions MLM (niveau 1 = 3%, niveau 2 = 1%)
      db.get('SELECT parrain_id FROM users WHERE id=?', [req.user.id], (e, u) => {
        if (u && u.parrain_id) {
          db.run('INSERT INTO commissions (user_id,commande_id,montant,niveau) VALUES (?,?,?,1)',
            [u.parrain_id, cid, total * 0.03]);
          db.get('SELECT parrain_id FROM users WHERE id=?', [u.parrain_id], (e2, u2) => {
            if (u2 && u2.parrain_id) {
              db.run('INSERT INTO commissions (user_id,commande_id,montant,niveau) VALUES (?,?,?,2)',
                [u2.parrain_id, cid, total * 0.01]);
            }
          });
        }
      });

      // Décrémenter le stock
      articles.forEach(a => {
        db.run('UPDATE produits SET stock = stock - ? WHERE id=?', [a.qty, a.id]);
      });

      // Email à l'admin
      db.get('SELECT nom,email FROM users WHERE id=?', [req.user.id], (e, cli) => {
        const lignes = articles.map(a => `- ${a.nom} x${a.qty} = ${a.prix * a.qty} FCFA`).join('\n');
        const body =
          `🛒 NOUVELLE COMMANDE #${cid}\n\n` +
          `Client : ${cli?.nom || ''} (${cli?.email || ''})\n` +
          `Téléphone : ${telephone}\n` +
          `Ville : ${ville_livraison}\n` +
          `Transport : ${transport}\n` +
          `Paiement : ${paiement}\n\n` +
          `Articles :\n${lignes}\n\n` +
          `TOTAL : ${total} FCFA`;

        if (process.env.MAIL_USER && process.env.MAIL_PASS) {
          transporter.sendMail({
            from: process.env.MAIL_USER,
            to: ADMIN_EMAIL,
            subject: `🛒 Commande #${cid} — NigerShop`,
            text: body
          }).catch(err => console.log('⚠️ Mail non envoyé :', err.message));
        } else {
          console.log('ℹ️  Email non configuré (.env manquant) — commande #' + cid);
        }
      });

      res.json({ id: cid });
    }
  );
});

app.get('/api/commandes', auth, (req, res) => {
  const q = req.user.role === 'admin'
    ? `SELECT c.*, u.nom as client_nom, u.email as client_email
       FROM commandes c JOIN users u ON u.id=c.user_id
       ORDER BY c.created_at DESC`
    : `SELECT * FROM commandes WHERE user_id=? ORDER BY created_at DESC`;
  const params = req.user.role === 'admin' ? [] : [req.user.id];

  db.all(q, params, (e, rows) => {
    if (!rows) return res.json([]);
    const promises = rows.map(c => new Promise(r => {
      db.all('SELECT * FROM commande_items WHERE commande_id=?', [c.id], (e2, its) => {
        c.articles = its || [];
        r(c);
      });
    }));
    Promise.all(promises).then(list => res.json(list));
  });
});

app.put('/api/commandes/:id/statut', auth, adminOnly, (req, res) => {
  const { statut } = req.body;
  db.run('UPDATE commandes SET statut=? WHERE id=?', [statut, req.params.id],
    () => res.json({ ok: true }));
});

// ---------- MESSAGES ----------
app.get('/api/messages', auth, (req, res) => {
  db.all(
    `SELECT m.*, u1.nom as exp_nom, u2.nom as dest_nom
     FROM messages m
     JOIN users u1 ON u1.id=m.expediteur_id
     JOIN users u2 ON u2.id=m.destinataire_id
     WHERE m.expediteur_id=? OR m.destinataire_id=?
     ORDER BY m.created_at DESC`,
    [req.user.id, req.user.id], (e, rows) => res.json(rows || []));
});

app.get('/api/messages/:otherId', auth, (req, res) => {
  db.all(
    `SELECT * FROM messages
     WHERE (expediteur_id=? AND destinataire_id=?)
        OR (expediteur_id=? AND destinataire_id=?)
     ORDER BY created_at ASC`,
    [req.user.id, req.params.otherId, req.params.otherId, req.user.id],
    (e, rows) => {
      db.run('UPDATE messages SET lu=1 WHERE destinataire_id=? AND expediteur_id=?',
        [req.user.id, req.params.otherId]);
      res.json(rows || []);
    });
});

app.post('/api/messages', auth, (req, res) => {
  const { destinataire_id, contenu, produit_id } = req.body;
  if (!destinataire_id || !contenu)
    return res.status(400).json({ message: 'Champs requis' });

  db.run(
    `INSERT INTO messages (expediteur_id,destinataire_id,produit_id,contenu)
     VALUES (?,?,?,?)`,
    [req.user.id, destinataire_id, produit_id || null, contenu],
    function (err) {
      if (err) return res.status(500).json({ message: 'Erreur' });
      res.json({ id: this.lastID });
    });
});

// Envoi d'email depuis la plateforme (contact hors-ligne)
app.post('/api/contact-email', auth, async (req, res) => {
  const { destinataire_id, sujet, message } = req.body;
  db.get('SELECT email,nom FROM users WHERE id=?', [destinataire_id], async (e, u) => {
    if (!u) return res.status(404).json({ message: 'Utilisateur introuvable' });
    if (!process.env.MAIL_USER || !process.env.MAIL_PASS)
      return res.status(500).json({ message: 'Email non configuré côté serveur' });

    try {
      await transporter.sendMail({
        from: process.env.MAIL_USER,
        to: u.email,
        subject: `[NigerShop] ${sujet}`,
        text: `Message de ${req.user.nom} (${req.user.email}) :\n\n${message}`
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ message: 'Erreur envoi : ' + err.message });
    }
  });
});

// ---------- ADMIN ----------
app.get('/api/admin/users', auth, adminOnly, (req, res) => {
  db.all(
    `SELECT id,nom,email,telephone,ville,role,verifie,code_parrain,parrain_id,created_at
     FROM users ORDER BY created_at DESC`,
    (e, rows) => res.json(rows || []));
});

app.put('/api/admin/users/:id/verifier', auth, adminOnly, (req, res) => {
  db.run('UPDATE users SET verifie=1 WHERE id=?', [req.params.id],
    () => res.json({ ok: true }));
});

app.delete('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  db.run('DELETE FROM users WHERE id=?', [req.params.id],
    () => res.json({ ok: true }));
});

app.get('/api/admin/stats', auth, adminOnly, (req, res) => {
  db.get('SELECT COUNT(*) as users FROM users', (e, u) => {
    db.get('SELECT COUNT(*) as produits FROM produits', (e2, p) => {
      db.get(
        'SELECT COUNT(*) as commandes, IFNULL(SUM(total),0) as ca FROM commandes',
        (e3, c) => {
          res.json({
            users: u ? u.users : 0,
            produits: p ? p.produits : 0,
            commandes: c ? c.commandes : 0,
            ca: c ? c.ca : 0
          });
        });
    });
  });
});

app.get('/api/admin/commissions', auth, (req, res) => {
  db.all(
    `SELECT c.*, u.nom as user_nom FROM commissions c
     JOIN users u ON u.id=c.user_id
     WHERE c.user_id=? ORDER BY c.created_at DESC`,
    [req.user.id], (e, rows) => res.json(rows || []));
});

// ============================================================
// CODES PROMO
// ============================================================

// Vérifier un code promo (côté client)
app.post('/api/promo/verifier', auth, (req, res) => {
  const { code, total } = req.body;
  if (!code) return res.status(400).json({ message: 'Code requis' });

  db.get(
    `SELECT * FROM codes_promo WHERE code=? AND actif=1`,
    [code.toUpperCase()],
    (e, c) => {
      if (!c) return res.status(404).json({ message: 'Code invalide ou inactif' });

      // Vérifier expiration
      if (c.date_expiration && new Date(c.date_expiration) < new Date())
        return res.status(400).json({ message: 'Code expiré' });

      // Vérifier montant minimum
      if (total < c.min_commande)
        return res.status(400).json({
          message: `Minimum ${c.min_commande} FCFA requis`
        });

      // Vérifier déjà utilisé par cet utilisateur
      db.get(
        `SELECT id FROM codes_promo_utilisations WHERE code_id=? AND user_id=?`,
        [c.id, req.user.id],
        (e2, usage) => {
          if (usage) return res.status(400).json({ message: 'Code déjà utilisé' });

          // Calculer la remise
          let remise = 0;
          if (c.type === 'pourcent') remise = Math.round(total * c.valeur / 100);
          else remise = Math.min(c.valeur, total);

          res.json({
            ok: true,
            code: c.code,
            type: c.type,
            valeur: c.valeur,
            remise,
            nouveau_total: total - remise
          });
        });
    });
});

// Admin : créer un code promo
app.post('/api/admin/promo', auth, adminOnly, (req, res) => {
  const { code, type, valeur, min_commande, date_expiration } = req.body;
  if (!code || !type || !valeur)
    return res.status(400).json({ message: 'Champs requis' });

  db.run(
    `INSERT INTO codes_promo (code,type,valeur,min_commande,date_expiration)
     VALUES (?,?,?,?,?)`,
    [code.toUpperCase(), type, valeur, min_commande || 0, date_expiration || null],
    function (err) {
      if (err) {
        if (err.message.includes('UNIQUE'))
          return res.status(400).json({ message: 'Ce code existe déjà' });
        return res.status(500).json({ message: 'Erreur' });
      }
      res.json({ id: this.lastID });
    });
});

// Admin : lister les codes promo
app.get('/api/admin/promo', auth, adminOnly, (req, res) => {
  db.all(
    `SELECT c.*,
       (SELECT COUNT(*) FROM codes_promo_utilisations WHERE code_id=c.id) as nb_utilisations
     FROM codes_promo c ORDER BY c.created_at DESC`,
    (e, rows) => res.json(rows || []));
});

// Admin : activer/désactiver un code
app.put('/api/admin/promo/:id/toggle', auth, adminOnly, (req, res) => {
  db.run(
    `UPDATE codes_promo SET actif = CASE WHEN actif=1 THEN 0 ELSE 1 END WHERE id=?`,
    [req.params.id],
    () => res.json({ ok: true }));
});

// Admin : supprimer un code
app.delete('/api/admin/promo/:id', auth, adminOnly, (req, res) => {
  db.run('DELETE FROM codes_promo WHERE id=?', [req.params.id],
    () => res.json({ ok: true }));
});

// ---------- ROUTE CATCH-ALL (compatible Express 4) ----------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------- DÉMARRAGE ----------
app.listen(PORT, () => {
  console.log('🚀 NigerShop sur http://localhost:' + PORT);
  console.log('📧 Admin :', ADMIN_EMAIL, '/', ADMIN_PASSWORD);
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
    console.log('⚠️  MAIL_USER / MAIL_PASS non configurés → emails désactivés');
  }
  if (!process.env.JWT_SECRET) {
    console.log('⚠️  JWT_SECRET non configuré → utilise une valeur par défaut (INSÉCURISÉ en prod)');
  }
});

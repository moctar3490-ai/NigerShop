const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('nigershop.db');

const NOUVEL_EMAIL = 'nigershop.ne@gmail.com';

console.log('🔄 Mise à jour de l\'admin...');

db.run(
  'UPDATE users SET email=? WHERE role="admin"',
  [NOUVEL_EMAIL],
  function(err) {
    if (err) {
      console.error('❌ Erreur:', err.message);
      process.exit(1);
    }

    console.log(`✅ Admin mis à jour (${this.changes} ligne(s))`);

    // Vérification
    db.all('SELECT id, nom, email, role, verifie FROM users WHERE role="admin"', (e, rows) => {
      if (e) {
        console.error('❌ Erreur vérif:', e.message);
        process.exit(1);
      }

      console.log('\n📋 Admin actuel en base :');
      rows.forEach(u => {
        console.log(`   • ID: ${u.id}`);
        console.log(`   • Nom: ${u.nom}`);
        console.log(`   • Email: ${u.email}`);
        console.log(`   • Rôle: ${u.role}`);
        console.log(`   • Vérifié: ${u.verifie ? 'Oui' : 'Non'}`);
      });

      console.log('\n🎉 Terminé !');
      process.exit(0);
    });
  }
);

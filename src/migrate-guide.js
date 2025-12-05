#!/usr/bin/env node

/**
 * Database migration to add guide and recording rules tables
 *
 * NOTE: As of the latest version, the app automatically creates guide tables
 * on startup. This script is kept for manual migration if needed, but is no
 * longer required. Simply starting the app will auto-upgrade the database.
 *
 * Usage: node src/migrate-guide.js (optional, for manual migration)
 */

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

function migrate() {
  console.log('Starting guide data migration...');

  const db = new sqlite3.Database('./hdhomerun.db', (err) => {
    if (err) {
      console.error('Failed to open database:', err);
      process.exit(1);
    }
  });

  // Read full schema and extract only the guide-related portions
  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const fullSchema = fs.readFileSync(schemaPath, 'utf-8');

  // Extract only the guide and recording rules section
  const guideSchemaMatch = fullSchema.match(
    /-- Program Guide and Recording Rules Tables[\s\S]*$/
  );

  if (!guideSchemaMatch) {
    console.error('Could not find guide schema in schema.sql');
    db.close();
    process.exit(1);
  }

  const guideSchema = guideSchemaMatch[0];

  // Remove comment lines
  const cleanSchema = guideSchema
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n');

  // Execute the guide schema
  db.exec(cleanSchema, (err) => {
    if (err) {
      console.error('Migration failed:', err);
      console.error('Error details:', err.message);
      db.close();
      process.exit(1);
    }

    console.log('Migration completed successfully!');
    console.log('Added tables: guide_channels, guide_programs, recording_rules');
    console.log('Added views: current_guide, recording_rules_detail');

    db.close((err) => {
      if (err) {
        console.error('Error closing database:', err);
      }
      process.exit(0);
    });
  });
}

migrate();

// Development fixtures only; M4's reviewed authoring pipeline replaces these pools.
import { writeFileSync } from 'node:fs';
const pools = [
  [
    [
      'Which key identifies every row?',
      'Primary key',
      'Foreign key',
      'Nullable column',
      'Default value',
      'A primary key uniquely identifies a row and cannot contain NULL.',
    ],
    [
      'Which key references another table?',
      'Foreign key',
      'Candidate key',
      'Superkey',
      'Composite primary key',
      'A foreign key requires a matching referenced key, unless its value is NULL and allowed.',
    ],
    [
      'Which constraint forbids missing values?',
      'NOT NULL',
      'UNIQUE',
      'DEFAULT',
      'FOREIGN KEY',
      'NOT NULL rejects a NULL value.',
    ],
    [
      'Which constraint rejects duplicate non-NULL values?',
      'UNIQUE',
      'NOT NULL',
      'DEFAULT',
      'CHECK (true)',
      'UNIQUE disallows duplicate non-NULL values.',
    ],
    [
      'What is a minimal superkey?',
      'Candidate key',
      'Foreign key',
      'Any attribute',
      'Default key',
      'A candidate key is a superkey with no redundant attributes.',
    ],
    [
      'A key uses two columns. What is it?',
      'Composite key',
      'Partial value',
      'Nullable key',
      'Scalar key',
      'A composite key consists of more than one column.',
    ],
    [
      'What describes a table’s structure?',
      'Schema',
      'Current row count',
      'Query result',
      'Transaction log',
      'A schema defines structure, including relations, attributes and constraints.',
    ],
    [
      'Which type stores true or false?',
      'boolean',
      'integer',
      'date',
      'text',
      'PostgreSQL boolean stores true, false, or NULL if permitted.',
    ],
    [
      'Which type stores calendar dates?',
      'date',
      'boolean',
      'integer',
      'bytea',
      'The date type represents a calendar date.',
    ],
    [
      'Which constraint checks positive prices?',
      'CHECK (price > 0)',
      'UNIQUE (price)',
      'DEFAULT 0',
      'PRIMARY KEY (price)',
      'CHECK evaluates a predicate; add NOT NULL if missing prices must also be forbidden.',
    ],
    [
      'Can a primary-key column contain NULL?',
      'No',
      'Always',
      'Only once',
      'Only in empty strings',
      'Every primary-key column is implicitly NOT NULL.',
    ],
    [
      'Can a table have several candidate keys?',
      'Yes',
      'Never',
      'Only without rows',
      'Only with NULLs',
      'Several minimal attribute sets may each uniquely identify a row.',
    ],
    [
      'Does adding columns preserve a superkey?',
      'Yes',
      'Never',
      'Only for text columns',
      'Only for empty tables',
      'A superset of a superkey still uniquely identifies a row.',
    ],
    [
      'Must every foreign-key value be unique?',
      'No',
      'Always',
      'Only integers',
      'Only strings',
      'Many referencing rows may refer to the same parent row.',
    ],
    [
      'What does entity integrity require?',
      'Primary keys cannot be NULL',
      'Every column must be unique',
      'Every table needs a foreign key',
      'Every column must have defaults',
      'Entity integrity requires valid non-NULL primary-key identification.',
    ],
  ],
  [
    [
      'Which command creates a table?',
      'CREATE TABLE',
      'INSERT INTO',
      'UPDATE',
      'SELECT',
      'CREATE TABLE defines a new relation and belongs to DDL.',
    ],
    [
      'Which command adds a row?',
      'INSERT',
      'ALTER',
      'DROP',
      'GRANT',
      'INSERT adds rows and belongs to DML.',
    ],
    [
      'Which command changes existing rows?',
      'UPDATE',
      'CREATE',
      'REVOKE',
      'COMMIT',
      'UPDATE modifies existing row values.',
    ],
    [
      'Which command removes matching rows?',
      'DELETE',
      'DROP TABLE',
      'ALTER TABLE',
      'GRANT',
      'DELETE removes rows, optionally selected using WHERE.',
    ],
    [
      'Which command removes a table definition?',
      'DROP TABLE',
      'DELETE',
      'SELECT',
      'ROLLBACK',
      'DROP TABLE removes the table itself, not merely its rows.',
    ],
    [
      'Which command adds a column?',
      'ALTER TABLE',
      'INSERT',
      'UPDATE',
      'COMMIT',
      'ALTER TABLE changes a table definition.',
    ],
    [
      'Which command makes transaction changes permanent?',
      'COMMIT',
      'ROLLBACK',
      'SAVEPOINT',
      'REVOKE',
      'COMMIT successfully ends the transaction and persists its changes.',
    ],
    [
      'Which command undoes an uncommitted transaction?',
      'ROLLBACK',
      'COMMIT',
      'GRANT',
      'SELECT',
      'ROLLBACK abandons changes in the current transaction.',
    ],
    [
      'Which command marks a partial rollback point?',
      'SAVEPOINT',
      'COMMIT',
      'CREATE DATABASE',
      'GRANT',
      'SAVEPOINT marks a point that ROLLBACK TO can return to.',
    ],
    [
      'Which command gives a privilege?',
      'GRANT',
      'REVOKE',
      'INSERT',
      'SAVEPOINT',
      'GRANT assigns privileges to a role.',
    ],
    [
      'Which command removes a granted privilege?',
      'REVOKE',
      'GRANT',
      'DROP COLUMN',
      'DELETE',
      'REVOKE removes a privilege grant.',
    ],
    [
      'Which command starts a transaction?',
      'BEGIN',
      'END TABLE',
      'GRANT',
      'ALTER',
      'BEGIN opens a transaction block.',
    ],
    [
      'Which family contains CREATE and ALTER?',
      'DDL',
      'DML',
      'TCL',
      'DCL',
      'Data Definition Language describes commands that define database structures.',
    ],
    [
      'Which family contains COMMIT and ROLLBACK?',
      'TCL',
      'DDL',
      'DML',
      'DCL',
      'Transaction Control Language includes COMMIT and ROLLBACK.',
    ],
    [
      'Which family contains GRANT and REVOKE?',
      'DCL',
      'DDL',
      'DML',
      'TCL',
      'Data Control Language includes privilege management commands.',
    ],
  ],
];
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
let sql = `-- Generated by scripts/generate-seed.mjs. Local reset only.\n-- 45 fixtures per round: 15 easy, 20 medium, 10 hard.\n-- Repeated concepts exercise pool mechanics; difficulty is synthetic, not classroom-ready.\nbegin;\ninsert into public.rounds values\n(1,'L1','vault-of-keys','The Vault of Keys'),\n(2,'L2','guild-city','Guild City'),\n(3,'L3','cipher-lock','The Cipher Lock'),\n(4,'L4','alchemists-workshop','The Alchemist’s Workshop'),\n(5,'L5','card-table','The Card Table'),\n(6,'L6','orbit-grand-prix','Orbit Grand Prix'),\n(7,'L7','nesting-temple','The Nesting Temple'),\n(8,'L8','noir-bureau','Noir Bureau'),\n(9,'L10','cartographers-finale','The Cartographer’s Finale');\n`;
for (const [round, pool] of pools.entries()) {
  for (let n = 0; n < 45; n++) {
    const [stem, correct, ...rest] = pool[n % 15];
    const explanation = rest.pop();
    const prefix =
      n < 15 ? '' : n < 30 ? 'At the gate: ' : 'Inside the vault: ';
    const difficulty = n < 15 ? 'easy' : n < 35 ? 'medium' : 'hard';
    sql += `with q as (insert into public.questions(round_id,display_type,difficulty,stem,explanation) values(${round + 1},'concept',${quote(difficulty)},${quote(prefix + stem)},${quote(explanation)}) returning id)\ninsert into public.options(question_id,body,is_correct,misconception) select q.id,v.body,v.correct,v.misconception from q cross join (values\n`;
    sql += [correct, ...rest]
      .map(
        (text, i) =>
          `(${quote(JSON.stringify({ text }))}::jsonb,${i === 0},${i === 0 ? 'null' : quote(`Confuses ${correct} with ${text}`)})`,
      )
      .join(',\n');
    sql += ') v(body,correct,misconception);\n';
  }
}
sql += 'commit;\n';
writeFileSync(new URL('../supabase/seed.sql', import.meta.url), sql);

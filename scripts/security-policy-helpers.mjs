export function isApprovedLicenseExpression(expression, allowedLicenses) {
  if (typeof expression !== 'string' || !expression.trim()) return false;
  if (allowedLicenses.has(expression)) return true;

  const alternatives = expression.split(/\s+OR\s+/u);
  return (
    alternatives.length > 1 &&
    alternatives.every(
      (license) => license === license.trim() && allowedLicenses.has(license),
    )
  );
}

export function hasCompleteSqlStatement(sql) {
  let state = 'code';
  let blockDepth = 0;
  let dollarDelimiter = '';
  let lastSignificantCharacter = '';

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (state === 'line-comment') {
      if (character === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (character === '/' && next === '*') {
        blockDepth += 1;
        index += 1;
      } else if (character === '*' && next === '/') {
        blockDepth -= 1;
        index += 1;
        if (blockDepth === 0) state = 'code';
      }
      continue;
    }
    if (state === 'single-quote') {
      if (character === "'" && next === "'") index += 1;
      else if (character === "'") state = 'code';
      continue;
    }
    if (state === 'double-quote') {
      if (character === '"' && next === '"') index += 1;
      else if (character === '"') state = 'code';
      continue;
    }
    if (state === 'dollar-quote') {
      if (sql.startsWith(dollarDelimiter, index)) {
        index += dollarDelimiter.length - 1;
        state = 'code';
      }
      continue;
    }

    if (character === '-' && next === '-') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      state = 'block-comment';
      blockDepth = 1;
      index += 1;
      continue;
    }
    if (character === "'") {
      state = 'single-quote';
      lastSignificantCharacter = character;
      continue;
    }
    if (character === '"') {
      state = 'double-quote';
      lastSignificantCharacter = character;
      continue;
    }
    if (character === '$') {
      const delimiter = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u.exec(
        sql.slice(index),
      )?.[0];
      if (delimiter) {
        state = 'dollar-quote';
        dollarDelimiter = delimiter;
        lastSignificantCharacter = '$';
        index += delimiter.length - 1;
        continue;
      }
    }
    if (!/\s/u.test(character)) lastSignificantCharacter = character;
  }

  return (
    (state === 'code' || state === 'line-comment') &&
    lastSignificantCharacter === ';'
  );
}

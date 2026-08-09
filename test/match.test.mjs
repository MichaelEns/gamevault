import { normalizeTitle, similarity, titlesMatch, isAddon } from '../lib/match.mjs';

let fails = 0;
const ok = (cond, msg) => {
  if (!cond) { console.log(`  FAIL: ${msg}`); fails++; }
  else console.log(`  ok:   ${msg}`);
};

console.log('normalizeTitle -- editions/platform noise collapse');
for (const [a, b] of [
  ['Hades', 'Hades\u2122'],
  ['Hades', 'Hades - Windows'],
  ['DOOM Eternal', 'DOOM Eternal Deluxe Edition'],
  ['The Witcher 3: Wild Hunt', 'The Witcher 3 Wild Hunt - Game of the Year Edition'],
  ['Hades II', 'Hades 2'],
  ['Final Fantasy VII', 'Final Fantasy 7'],
  ['Ori and the Blind Forest', 'Ori & the Blind Forest'],
]) ok(normalizeTitle(a) === normalizeTitle(b),
      `"${a}" == "${b}"  (${normalizeTitle(a)} | ${normalizeTitle(b)})`);

console.log('\nMUST NOT match -- sequels and different games');
for (const [a, b] of [
  ['Hades', 'Hades II'],
  ['Hades', 'Hades 2'],
  ['Portal', 'Portal 2'],
  ['Final Fantasy VII', 'Final Fantasy VIII'],
  ['The Witcher 2', 'The Witcher 3'],
  ['Dark Souls II', 'Dark Souls III'],
  ['Celeste', 'Selaco'],
  ['Doom', 'Doom Eternal'],
]) ok(!titlesMatch(a, b), `"${a}" != "${b}"  (sim=${similarity(a, b).toFixed(2)})`);

console.log('\nMUST match -- same game across stores');
for (const [a, b] of [
  ['Hades', 'Hades'],
  ['Cyberpunk 2077', 'Cyberpunk 2077\u2122'],
  ['A Plague Tale: Requiem', 'A Plague Tale: Requiem - Windows'],
  ["Baldur's Gate 3", 'Baldurs Gate 3'],
  ['STAR WARS Jedi: Survivor', 'Star Wars Jedi Survivor'],
]) ok(titlesMatch(a, b), `"${a}" == "${b}"  (sim=${similarity(a, b).toFixed(2)})`);

console.log('\nisAddon -- DLC/soundtrack must not count as owning the game');
for (const t of ['Hades Original Soundtrack', 'Celeste - Soundtrack', 'Game X DLC',
                 'Something Season Pass', 'Foo Demo', 'Bar Playtest',
                 'Cyberpunk 2077 Russian Voiceover Pack (Base game)',
                 'Cyberpunk 2077: Ultimate Edition Chinese (Simplified) Voiceover Pack',
                 'Game Y Character Pack', 'Game Z Currency Pack'])
  ok(isAddon(t), `addon: "${t.slice(0, 48)}"`);
for (const t of ['Hades', 'Celeste', 'Portal 2', 'Season of the Cat', 'Cyberpunk 2077'])
  ok(!isAddon(t), `not addon: "${t}"`);

console.log('');
if (fails) { console.log(`${fails} assertion(s) failed.`); process.exit(1); }
console.log('All matcher tests passed.');

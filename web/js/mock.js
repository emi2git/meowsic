// Mock library for the UI phase. Lyrics and tunes are public domain / traditional;
// sheet pages are drawn by sheet-art.js. Nothing here comes from the real library.

export const TAGS = ['Musical', 'Disney', 'Frozen', 'Les Miserables', 'Phantom of the opera', 'Matilda', 'Miss Saigon',
  'Sunset Boulevard', 'Movie', 'Anime', 'Pop', 'Rock', 'Ballad', 'Jazz', 'Folk', 'Country', 'Classical', 'Christmas',
  'Children', 'English', 'Vietnamese', 'Chinese', 'Russian', 'Korea', 'Japan', 'Singapore'];

// title | artist | pages | tags
const SHEETS = `Memory|Andrew Lloyd Webber|3|Musical,English
The Phantom of the Opera|Andrew Lloyd Webber|5|Musical,Phantom of the opera,English
The Music of the Night|Andrew Lloyd Webber|4|Musical,Phantom of the opera,English
Think of Me|Andrew Lloyd Webber|3|Musical,Phantom of the opera,English
I Dreamed a Dream|Claude-Michel Schönberg|4|Musical,Les Miserables,English
On My Own|Claude-Michel Schönberg|3|Musical,Les Miserables,English
Castle on a Cloud|Claude-Michel Schönberg|2|Musical,Les Miserables,Children
One Day More|Claude-Michel Schönberg|6|Musical,Les Miserables
Bring Him Home|Claude-Michel Schönberg|3|Musical,Les Miserables,Ballad
Let It Go|Kristen Anderson-Lopez|5|Disney,Frozen,Movie
Do You Want to Build a Snowman|Kristen Anderson-Lopez|4|Disney,Frozen,Children
Into the Unknown|Kristen Anderson-Lopez|4|Disney,Frozen
A Whole New World|Alan Menken|2|Disney,Movie,Ballad
Beauty and the Beast|Alan Menken|2|Disney,Movie,Ballad
Part of Your World|Alan Menken|3|Disney,Movie
How Far I'll Go|Lin-Manuel Miranda|4|Disney,Movie
Remember Me|Kristen Anderson-Lopez|2|Disney,Movie
Can You Feel the Love Tonight|Elton John|3|Disney,Movie,Ballad
A Million Dreams|Benj Pasek|4|Movie,Musical
A Thousand Years|Christina Perri|2|Pop,Ballad
16 Going on 17|Richard Rodgers|1|Musical
Edelweiss|Richard Rodgers|1|Musical,Folk
Do-Re-Mi|Richard Rodgers|3|Musical,Children
City of Stars|Justin Hurwitz|3|Movie,Jazz
Moon River|Henry Mancini|2|Movie,Jazz
Over the Rainbow|Harold Arlen|2|Movie,Ballad
Naughty|Tim Minchin|5|Musical,Matilda,Children
When I Grow Up|Tim Minchin|4|Musical,Matilda,Children
The Sun and Moon|Claude-Michel Schönberg|3|Musical,Miss Saigon
Last Night of the World|Claude-Michel Schönberg|4|Musical,Miss Saigon
As If We Never Said Goodbye|Andrew Lloyd Webber|4|Musical,Sunset Boulevard
With One Look|Andrew Lloyd Webber|3|Musical,Sunset Boulevard
Yesterday|The Beatles|1|Pop,English
Let It Be|The Beatles|2|Pop,Rock
Imagine|John Lennon|2|Pop,Ballad
Hallelujah|Leonard Cohen|3|Ballad,Folk
Perfect|Ed Sheeran|3|Pop,Ballad
All of Me|John Legend|4|Pop,Ballad
Bohemian Rhapsody|Queen|8|Rock
Take Me Home, Country Roads|John Denver|2|Country,Folk
Jolene|Dolly Parton|2|Country
Autumn Leaves|Joseph Kosma|1|Jazz
Fly Me to the Moon|Bart Howard|2|Jazz
River Flows in You|Yiruma|4|Classical,Korea
Kiss the Rain|Yiruma|3|Classical,Korea
Canon in D|Johann Pachelbel|4|Classical
Für Elise|Ludwig van Beethoven|3|Classical
Moonlight Sonata, 1st Movement|Ludwig van Beethoven|4|Classical
Clair de Lune|Claude Debussy|6|Classical
Gymnopédie No. 1|Erik Satie|2|Classical
Nocturne Op. 9 No. 2|Frédéric Chopin|4|Classical
Prelude in C Major, BWV 846|Johann Sebastian Bach|2|Classical
Minuet in G|Christian Petzold|1|Classical,Children
Merry-Go-Round of Life|Joe Hisaishi|5|Anime,Japan,Movie
Summer|Joe Hisaishi|3|Anime,Japan
One Summer's Day|Joe Hisaishi|3|Anime,Japan,Movie
Spring Day|BTS|3|Pop,Korea
Arirang|Traditional|1|Folk,Korea
Wait for Me|Konstantin Simonov|2|Russian
Moscow Nights|Vasily Solovyov-Sedoi|2|Russian,Folk
Katyusha|Matvey Blanter|1|Russian,Folk
The Moon Represents My Heart|Teresa Teng|2|Chinese,Ballad
Tian Mi Mi|Teresa Teng|2|Chinese,Pop
Mo Li Hua|Traditional|1|Chinese,Folk
Diễm Xưa|Trịnh Công Sơn|2|Vietnamese,Ballad
Bèo Dạt Mây Trôi|Traditional|1|Vietnamese,Folk
Home|Dick Lee|2|Singapore
Count On Me Singapore|Hugh Harrison|2|Singapore,Children
Silent Night|Franz Gruber|1|Christmas,Classical
Jingle Bells|James Lord Pierpont|2|Christmas,Children
We Wish You a Merry Christmas|Traditional|1|Christmas,Children
Last Christmas|Wham!|3|Christmas,Pop
Somewhere|Leonard Bernstein|2|Musical
Tomorrow|Charles Strouse|2|Musical,Children
Sunrise, Sunset|Jerry Bock|2|Musical`;

export const CHORD_CHARTS = [
  { title: 'Amazing Grace', artist: 'John Newton', source: 'ultimate-guitar', key: 'G', capo: 0, tags: ['Folk', 'English'], text:
`{c: Verse 1}
A[G]mazing grace, how [C]sweet the [G]sound
That saved a wretch like [D]me
I [G]once was lost, but [C]now I'm [G]found
Was [Em]blind, but [D]now I [G]see

{c: Verse 2}
'Twas [G]grace that taught my [C]heart to [G]fear
And grace my fears re[D]lieved
How [G]precious did that [C]grace ap[G]pear
The [Em]hour I [D]first be[G]lieved` },
  { title: 'Twinkle, Twinkle, Little Star', artist: 'Traditional', source: 'ultimate-guitar', key: 'C', capo: 0, tags: ['Children', 'English'], text:
`[C]Twinkle, twinkle, [F]little [C]star
[F]How I wonder [C]what you [G]are
[C]Up above the [F]world so [G]high
[C]Like a diamond [F]in the [G]sky
[C]Twinkle, twinkle, [F]little [C]star
[F]How I wonder [C]what [G]you [C]are` },
  { title: 'Oh! Susanna', artist: 'Stephen Foster', source: 'ultimate-guitar', key: 'D', capo: 0, tags: ['Folk', 'Country', 'English'], text:
`{c: Verse}
I [D]come from Alabama with my [A]banjo on my knee
I'm [D]going to Louisiana, my [A]true love for to [D]see

{c: Chorus}
[G]Oh, Su[G]sanna, oh [D]don't you cry for [A]me
For I [D]come from Alabama with my [A]banjo on my [D]knee` },
  { title: 'Auld Lang Syne', artist: 'Robert Burns', source: 'ultimate-guitar', key: 'F', capo: 0, tags: ['Folk', 'Christmas'], text:
`Should [F]auld acquaintance [C7]be forgot
And [F]never brought to [Bb]mind
Should [F]auld acquaintance [C7]be forgot
And [Dm]days of [Bb]auld [C7]lang [F]syne

{c: Chorus}
For [F]auld lang syne, my [C7]dear
For [F]auld lang [Bb]syne
We'll [F]take a cup of [C7]kindness yet
For [Dm]days of [Bb]auld [C7]lang [F]syne` },
  { title: 'Happy Birthday to You', artist: 'Patty and Mildred Hill', source: 'ultimate-guitar', key: 'G', capo: 0, tags: ['Children'], text:
`Happy [G]birthday to [D]you
Happy birthday to [G]you
Happy [G7]birthday, dear [C]friend
Happy [G]birthday [D]to [G]you` },
  { title: 'Home on the Range', artist: 'Brewster Higley', source: 'ultimate-guitar', key: 'C', capo: 0, tags: ['Country', 'Folk'], text:
`Oh, [C]give me a [C7]home where the [F]buffalo [Fm]roam
Where the [C]deer and the [Am]antelope [D7]play [G7]
Where [C]seldom is [C7]heard a [F]discouraging [Fm]word
And the [C]skies are not [G7]cloudy all [C]day

{c: Chorus}
[G7]Home, home on the [C]range
Where the [Am]deer and the [D7]antelope [G7]play
Where [C]seldom is [C7]heard a [F]discouraging [Fm]word
And the [C]skies are not [G7]cloudy all [C]day` },
  { title: 'Silent Night', artist: 'Franz Gruber', source: 'ultimate-guitar', key: 'Bb', capo: 0, tags: ['Christmas'], text:
`[Bb]Silent night, holy night
[F7]All is calm, [Bb]all is bright
[Eb]Round yon virgin [Bb]mother and child
[Eb]Holy infant so [Bb]tender and mild
[F7]Sleep in heavenly [Bb]peace
[Bb]Sleep in [F7]heavenly [Bb]peace` },
  { title: 'Clementine', artist: 'Traditional', source: 'ultimate-guitar', key: 'F', capo: 0, tags: ['Folk', 'Children'], text:
`In a [F]cavern, in a canyon
Excavating for a [C7]mine
Dwelt a [F]miner, forty-niner
And his [C7]daughter, Clemen[F]tine

{c: Chorus}
Oh my [F]darling, oh my darling
Oh my darling Clemen[C7]tine
You are [F]lost and gone forever
Dreadful [C7]sorry, Clemen[F]tine` },
  { title: 'Bắc Kim Thang', artist: 'Đồng dao', source: 'hopamchuan', key: 'C', capo: 0, tags: ['Vietnamese', 'Children', 'Folk'], text:
`[C]Bắc kim thang cà [G]lang bí rợ
[C]Cột qua kèo là [G]kèo qua [C]cột
[C]Chú bìm bịp kêu [G]bà bằng chị
[C]Lấy chi mà [G]lấy, lấy chi [C]chăng` },
  { title: 'Kalinka', artist: 'Ivan Larionov', source: 'ultimate-guitar', key: 'Am', capo: 0, tags: ['Russian', 'Folk'], text:
`{c: Chorus}
[Am]Kalinka, kalinka, kalinka [E]moya
V sa[E]du yagoda malinka, ma[Am]linka moya
[Am]Ah, pod sosnoyu, pod zelenoyu
[Dm]Spat po[Am]lozhite vy [E]menya` },
  { title: 'Scarborough Fair', artist: 'Traditional', source: 'ultimate-guitar', key: 'Am', capo: 0, tags: ['Folk', 'English', 'Ballad'], text:
`[Am]Are you going to [G]Scarborough [Am]Fair
[C]Parsley, [Am]sage, rose[D]mary and [Am]thyme
Re[Am]member [C]me to one who [G]lives [F]there
[Am]She once [G]was a true love of [Am]mine` },
];

// More songs that the mock web search can "find" but that are not in the library yet.
export const SEARCH_EXTRA = [
  { title: 'Danny Boy', artist: 'Frederic Weatherly', source: 'ultimate-guitar', key: 'C', capo: 0, text:
`Oh [C]Danny boy, the [C7]pipes, the pipes are [F]calling
From [C]glen to glen, and [Am]down the mountain [G]side
The [C]summer's gone, and [C7]all the roses [F]falling
It's [C]you, it's you must [G]go and I must [C]bide` },
  { title: 'Greensleeves', artist: 'Traditional', source: 'ultimate-guitar', key: 'Am', capo: 0, text:
`A[Am]las, my love, you [G]do me wrong
To [Am]cast me off dis[E]courteously
For [Am]I have loved [G]you well and long
De[Am]lighting [E]in your [Am]company` },
  { title: 'Lý Cây Bông', artist: 'Dân ca Nam Bộ', source: 'hopamchuan', key: 'G', capo: 0, text:
`[G]Bông xanh, bông trắng, [D]lại vàng bông [G]tím
[G]Bông xanh, bông trắng [C]lại vàng bông [G]tím
[Em]Ối a tình [D]tang` },
  { title: 'Cò Lả', artist: 'Dân ca Bắc Bộ', source: 'hopamchuan', key: 'D', capo: 0, text:
`[D]Con cò cò bay lả, lả bay [A]la
[D]Bay qua qua cửa phủ, bay về [A]Đồng [D]Đăng` },
];

export const TUNES = {
  twinkle: { title: 'Twinkle, Twinkle, Little Star', fifths: 0, beats: 4, bpm: 96,
    lyrics: 'Twin kle twin kle lit tle star how I won der what you are Up a bove the world so high like a dia mond in the sky Twin kle twin kle lit tle star how I won der what you are'.split(' '),
    measures: [
      ['C', 'C4 C4 G4 G4'], ['F', 'A4 A4 G4:2'], ['F', 'F4 F4 E4 E4'], ['G7', 'D4 D4 C4:2'],
      ['C', 'G4 G4 F4 F4'], ['G', 'E4 E4 D4:2'], ['C', 'G4 G4 F4 F4'], ['G', 'E4 E4 D4:2'],
      ['C', 'C4 C4 G4 G4'], ['F', 'A4 A4 G4:2'], ['F', 'F4 F4 E4 E4'], ['C', 'D4 D4 C4:2']] },
  ode: { title: 'Ode to Joy', fifths: 0, beats: 4, bpm: 104,
    measures: [
      ['C', 'E4 E4 F4 G4'], ['G', 'G4 F4 E4 D4'], ['C', 'C4 C4 D4 E4'], ['G', 'E4:1.5 D4:0.5 D4:2'],
      ['C', 'E4 E4 F4 G4'], ['G', 'G4 F4 E4 D4'], ['C', 'C4 C4 D4 E4'], ['C', 'D4:1.5 C4:0.5 C4:2']] },
  grace: { title: 'Amazing Grace', fifths: 1, beats: 3, bpm: 76,
    lyrics: ['A', 'maz', 'ing', '', 'grace', 'how', 'sweet', 'the', 'sound', 'that', 'saved', 'a', '', 'wretch', 'like', 'me', ''],
    measures: [
      ['G', 'r:2 D4'], ['G', 'G4:2 B4:0.5 G4:0.5'], ['C', 'B4:2 A4'], ['G', 'G4:2 E4'], ['Em', 'D4:2 D4'],
      ['G', 'G4:2 B4:0.5 G4:0.5'], ['C', 'B4:2 A4'], ['D', 'D5:3'], ['D', 'D5:3']] },
  jacques: { title: 'Frère Jacques', fifths: 0, beats: 4, bpm: 100,
    lyrics: 'Frè re Jac ques Frè re Jac ques Dor mez vous Dor mez vous Son nez les ma ti nes Son nez les ma ti nes Ding dang dong Ding dang dong'.split(' '),
    measures: [
      ['C', 'C4 D4 E4 C4'], ['C', 'C4 D4 E4 C4'], ['C', 'E4 F4 G4:2'], ['C', 'E4 F4 G4:2'],
      ['C', 'G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4 C4'], ['C', 'G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4 C4'], ['G7', 'C4 G3 C4:2'], ['C', 'C4 G3 C4:2']] },
};
for (const t of Object.values(TUNES))
  t.measures = t.measures.map(([chord, s]) => ({ chord, mel: s.split(' ').map((n) => { const [p, d] = n.split(':'); return [p, d ? +d : 1]; }) }));

const SCORES = [
  { tune: 'twinkle', title: 'Twinkle, Twinkle, Little Star', artist: 'Traditional', source: 'Audio file · twinkle.m4a', method: 'Direct transcription', tags: ['Children'] },
  { tune: 'ode', title: 'Ode to Joy', artist: 'Ludwig van Beethoven', source: 'YouTube · youtu.be/ode-to-joy', method: 'Arrangement', tags: ['Classical'] },
  { tune: 'grace', title: 'Amazing Grace (piano + vocals)', artist: 'John Newton', source: 'YouTube · youtu.be/amazing-grace', method: 'Direct transcription', tags: ['Folk'] },
  { tune: 'jacques', title: 'Frère Jacques', artist: 'Traditional', source: 'Audio file · frere-jacques.mp3', method: 'Piano accompaniment', tags: ['Children', 'Folk'] },
];

// deterministic pseudo-random so the mock looks the same on every device
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const DAY = 86400000;
const NOW = Date.now();

export function buildMock() {
  seed = 42;
  const items = [];
  let n = 0;
  const id = (k) => `${k}-${(++n).toString(36).padStart(3, '0')}`;
  SHEETS.trim().split('\n').forEach((row, i) => {
    const [title, artist, pages, tags] = row.split('|');
    const created = NOW - Math.floor((i * 4.3 + rand() * 3) * DAY) - 40 * DAY;
    items.push({ id: id('s'), kind: 'sheet', title, artist, tags: tags.split(','), createdAt: created, updatedAt: created,
      pages: +pages, source: rand() > 0.8 ? 'pdf' : 'photos', deleted: false });
  });
  CHORD_CHARTS.forEach((c, i) => {
    const created = NOW - Math.floor((i * 6 + 3) * DAY);
    items.push({ id: id('c'), kind: 'chords', title: c.title, artist: c.artist, tags: c.tags, createdAt: created, updatedAt: created,
      source: c.source, url: `https://${c.source === 'hopamchuan' ? 'hopamchuan.com' : 'tabs.ultimate-guitar.com'}/mock/${encodeURIComponent(c.title)}`,
      key: c.key, capo: c.capo, text: c.text, transpose: null, deleted: false });
  });
  SCORES.forEach((s, i) => {
    const created = NOW - Math.floor((i * 9 + 1) * DAY);
    const t = TUNES[s.tune];
    items.push({ id: id('m'), kind: 'score', title: s.title, artist: s.artist, tags: s.tags, createdAt: created, updatedAt: created,
      tune: s.tune, versions: ['original', 'lead', 'vocal'], source: s.source, method: s.method,
      key: ['C', 'G', 'D', 'A', 'E', 'B', 'F#'][t.fifths] + ' major', bpm: t.bpm, transpose: 0, deleted: false });
  });
  // a few in the bin
  for (const k of [7, 33, 52]) Object.assign(items[k], { deleted: true, deletedAt: NOW - k * 3600000 * 5 });

  const plays = [];
  const live = items.filter((x) => !x.deleted);
  const favs = live.filter((_, i) => i % 7 === 0);
  for (let d = 70; d >= 0; d--) {
    const sessions = rand() > 0.35 ? 1 + Math.floor(rand() * 3) : 0;
    for (let s = 0; s < sessions; s++) {
      const it = rand() > 0.5 ? favs[Math.floor(rand() * favs.length)] : live[Math.floor(rand() * live.length)];
      const opened = NOW - d * DAY - Math.floor(rand() * 10) * 3600000;
      plays.push({ itemId: it.id, openedAt: opened, closedAt: opened + (2 + Math.floor(rand() * 25)) * 60000 });
    }
  }

  const byTitle = (t) => items.find((x) => x.title === t)?.id;
  const collections = [
    { id: 'col-1', name: 'Piano recital — December', itemIds: ['Clair de Lune', 'River Flows in You', 'Memory', 'Ode to Joy', 'Gymnopédie No. 1'].map(byTitle).filter(Boolean) },
    { id: 'col-2', name: 'Ukulele club', itemIds: ['Amazing Grace', 'Oh! Susanna', 'Clementine', 'Home on the Range', 'Bắc Kim Thang'].map(byTitle).filter(Boolean) },
    { id: 'col-3', name: 'Christmas 2026', itemIds: ['Silent Night', 'Jingle Bells', 'We Wish You a Merry Christmas', 'Last Christmas', 'Auld Lang Syne'].map(byTitle).filter(Boolean) },
    { id: 'col-4', name: 'Musicals to learn', itemIds: ['One Day More', 'Naughty', 'The Music of the Night', 'A Million Dreams'].map(byTitle).filter(Boolean) },
  ];

  const jobs = [
    { id: 'job-1', title: 'One Day More (Les Misérables)', source: 'YouTube · youtu.be/one-day-more', output: 'Piano + vocals', method: 'Direct transcription', stage: 2, progress: 0.4, startedAt: NOW - 90000, status: 'running' },
  ];

  return { version: 1, items, tags: [...TAGS], collections, plays, jobs, annotations: {} };
}

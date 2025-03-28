import { Database } from "bun:sqlite";
import Prompts from "prompts";
import * as v from "valibot"; // 1.31 kB

const db = new Database("db.sqlite", { create: true, strict: true });
db.exec("PRAGMA journal_mode = WAL;");

db.exec(/* sql */ `CREATE TABLE IF NOT EXISTS mapping (
  filmweb_id INTEGER PRIMARY KEY,
  tmdb_id INTEGER NOT NULL,
	filmweb_rating INTEGER NOT NULL
);`);

const addMapping = db.prepare<unknown, [number, number, number]>(
	/* sql */ `
  INSERT INTO mapping (filmweb_id, tmdb_id, filmweb_rating) VALUES (?, ?, ?)
  ON CONFLICT (filmweb_id) DO UPDATE SET tmdb_id = excluded.tmdb_id, filmweb_rating = excluded.filmweb_rating
`,
);
const getMappingById = db.prepare<
	{ filmweb_id: number; tmdb_id: number; filmweb_rating: number },
	{ fid: number }
>(/* sql */ `SELECT filmweb_id, tmdb_id, filmweb_rating from mapping WHERE filmweb_id = $fid;`);

const API_URL = `https://api.themoviedb.org/3`;

// biome-ignore lint/suspicious/noExplicitAny: <explanation>
type Any = any;

const [_0, _1, ...searchWords] = Bun.argv;
const search = searchWords.join(" ");

const filmwebFile = Bun.file("filmweb.json", { type: "application/json" });
const filmwebJson = ((await filmwebFile.json()) as FilmwebData).filter((row) => {
	if (search) {
		return (
			row.original_title.toLowerCase().includes(search.toLowerCase()) ||
			row.pl_title.toLowerCase().includes(search.toLowerCase())
		);
	}
	return true;
});

await verifyAuth();

for (const filmwebFilm of filmwebJson) {
	const tmdbId = await getTmdbId(filmwebFilm);
	if (!tmdbId) {
		console.log(`No TMDB ID found for ${filmwebFilm.original_title} (${filmwebFilm.year})`);
		continue;
	}
	console.log(
		`${filmwebFilm.pl_title} [${filmwebFilm.original_title}] (${filmwebFilm.year}) - ${tmdbId} – ${filmwebFilm.user_rating}`,
	);
	addMapping.run(filmwebFilm.movie_id, tmdbId, filmwebFilm.user_rating);
	const result = await voteMovie(tmdbId, filmwebFilm.user_rating);

	console.log(`Rated`, result.status_message, `(${result.status_code})`);
	if (filmwebFilm.favorite) {
		const favoriteResult = await markAsFavorite(tmdbId);
		console.log(`Favourite`, favoriteResult.status_message, `(${favoriteResult.status_code})`, "\n");
	} else {
		console.log("");
	}
}

async function voteMovie(tmdbId: number, value: number) {
	return request(
		`/movie/${tmdbId}/rating`,
		{ method: "POST", body: JSON.stringify({ value }) },
		v.object({
			success: v.boolean(),
			status_code: v.number(),
			status_message: v.string(),
		}),
	);
}
async function markAsFavorite(tmdbId: number) {
	return request(
		`/account/${10127686}/favorite`,
		{ method: "POST", body: JSON.stringify({ media_type: "movie", media_id: tmdbId, favorite: true }) },
		v.object({
			success: v.boolean(),
			status_code: v.number(),
			status_message: v.string(),
		}),
	);
}

async function getTmdbId(filmwebFilm: FilmwebData[number]) {
	const tmdbId = getMappingById.get({ fid: filmwebFilm.movie_id });
	if (tmdbId) {
		return tmdbId.tmdb_id;
	}
	const searchResult = await searchMovie(
		filmwebFilm.original_title,
		filmwebFilm.pl_title,
		filmwebFilm.year.toString(),
	);
	if (searchResult.results.length > 1) {
		// console.log(
		// 	`Ambiguous search result: ${filmwebFilm.original_title} (${filmwebFilm.year}) – ${filmwebFilm.movie_id}`,
		// 	searchResult.results.map((result) => `${result.title} (${result.release_date}) – ${result.id}`),
		// );

		const response = await Prompts({
			type: "select",
			name: "imbd_id",
			message: `Select the correct movie for ${filmwebFilm.pl_title} [${filmwebFilm.original_title}] (${filmwebFilm.year})`,
			choices: [
				...searchResult.results.map((result) => ({
					title: `${result.title} (${result.release_date}) – https://image.tmdb.org/t/p/w300/${result.poster_path}`,
					value: result.id,
				})),
			],
			initial: 0,
		});
		return response.imbd_id as number;
	}
	if (searchResult.results.length === 0) {
		return null;
	}
	return searchResult.results[0].id;
}

async function verifyAuth() {
	await request(
		`/authentication`,
		{ method: "GET" },
		v.object({
			success: v.pipe(v.boolean()),
		}),
	);
}

async function searchMovie(title: string, pl_title: string, year: string) {
	const schema = v.object({
		page: v.number(),
		results: v.array(
			v.object({
				adult: v.boolean(),
				backdrop_path: v.nullish(v.string()),
				genre_ids: v.array(v.number()),
				id: v.number(),
				original_language: v.string(),
				original_title: v.string(),
				overview: v.string(),
				popularity: v.number(),
				poster_path: v.nullish(v.string()),
				release_date: v.string(),
				title: v.string(),
				video: v.boolean(),
				vote_average: v.number(),
				vote_count: v.number(),
			}),
		),
		total_pages: v.number(),
		total_results: v.number(),
	});

	const searchParams = new URLSearchParams({
		query: title,
		include_adult: "true",
		language: "en-US",
		page: "1",
		primary_release_year: year,
	});

	{
		const search = await request(`/search/movie?${searchParams}`, { method: "GET" }, schema);
		if (search.results.length > 0) {
			return search;
		}
	}

	searchParams.set("query", pl_title);
	return await request(`/search/movie?${searchParams}`, { method: "GET" }, schema);
}

type FilmwebData = {
	timestamp: number;
	favorite?: boolean;
	user_rating: number;
	global_rating: number;
	global_rating_count: number;
	original_title: string;
	pl_title: string;
	year: number;
	movie_id: number;
	url: string;
	date: string;
}[];

async function request<TSchema extends v.ObjectSchema<Any, Any>>(
	pathname: string,
	options: RequestInit,
	schema: TSchema,
) {
	const url = `${API_URL}${pathname}`;
	const res = await fetch(url, {
		...options,
		headers: {
			...options.headers,
			Authorization: `Bearer ${Bun.env.TMDB_API_KEY}`,
			"Content-Type": "application/json;charset=utf-8",
		},
	});

	if (!res.ok) {
		throw new Error(`HTTP error! status: ${res.status}`);
	}
	try {
		return v.parse(schema, await res.json());
	} catch (e) {
		if (e instanceof v.ValiError) {
			console.dir(e.issues, { depth: 9999 });
		} else {
			console.error(e);
		}
		throw e;
	}
}

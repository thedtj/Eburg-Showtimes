const functions = require('firebase-functions')
const admin = require('firebase-admin')
admin.initializeApp()
const axios = require('axios')
const cheerio = require('cheerio')

exports.scrape = functions.pubsub.schedule('0 0 * * 5').onRun(() => {
	const db = admin.firestore()
	const dateScraped = Date.now()

	// * Clear the Database
	function deleteCollection(db, collectionPath, batchSize) {
		let collectionRef = db.collection(collectionPath)
		let query = collectionRef.orderBy('__name__').limit(batchSize)

		return new Promise((resolve, reject) => {
			deleteQueryBatch(db, query, batchSize, resolve, reject)
		})
	}

	function deleteQueryBatch(db, query, batchSize, resolve, reject) {
		query
			.get()
			.then((snapshot) => {
				// When there are no documents left, we are done
				if (snapshot.size === 0) {
					return 0
				}

				// Delete documents in a batch
				let batch = db.batch()
				snapshot.docs.forEach((doc) => {
					batch.delete(doc.ref)
				})

				// eslint-disable-next-line promise/no-nesting
				return batch.commit().then(() => {
					return snapshot.size
				})
			})
			.then((numDeleted) => {
				if (numDeleted === 0) {
					resolve()
					return
				}

				// Recurse on the next process tick, to avoid
				// exploding the stack.
				process.nextTick(() => {
					deleteQueryBatch(db, query, batchSize, resolve, reject)
				})

				return
			})
			.catch(reject)
	}

	// * Scrape the Web
	async function getHTML(url) {
		const { data: html } = await axios.get(url)
		return html
	}

	// async function getMovieInfo(html) {
	// TODO: Get poster and synopsis
	// }

	async function getShowtimes(html) {
		const $ = cheerio.load(html)
		const movies = []

		$('.results, .resultsRed').each((i, elem) => {
			const rawData = $(elem)
				.text()
				.replace(/\n/g, '')
				.replace(/\t/g, '')
				.replace(/([*])/g, '')

			const cleanData = rawData.split('  ').filter((nonNull) => nonNull !== '')
			const chopThisData = cleanData

			const title = chopThisData.splice(0, 1)
			const runningTime = chopThisData.splice(-1, 1)
			const rating = chopThisData.splice(-1, 1)

			// eslint-disable-next-line quotes
			const showtimes = chopThisData.filter((time) => time.length > 1)

			const movie = {
				title: title[0],
				runningTime: runningTime[0],
				rating: rating[0],
				showtimes
			}

			movies.push(movie)
		})

		movies.shift()

		const comingSoon = movies.splice(movies.findIndex((movie) => movie.showtimes.length < 2))

		comingSoon.shift()

		return {
			movies,
			comingSoon
		}
	}

	async function getDates(html) {
		const $ = cheerio.load(html)
		let dates = ''

		$('.style21 strong font').each((i, elem) => {
			const data = $(elem)
				.text()
				.trim()
			dates = data
		})

		return dates
	}

	// * Write to the Database
	const addMovies = (movies) => {
		movies.map((movie) =>
			db.collection('movies').add({
				title: movie.title,
				runningTime: movie.runningTime,
				rating: movie.rating,
				showtimes: movie.showtimes
			})
		)
	}

	const addComingSoon = (comingSoon) => {
		comingSoon.shift()
		comingSoon.map((upcoming) =>
			db.collection('comingSoon').add({
				title: upcoming.title,
				startDate: upcoming.runningTime,
				rating: upcoming.rating
			})
		)
	}

	const addDates = (dates) => {
		db.collection('dates').add({
			showDates: dates,
			refreshed: dateScraped
		})
	}

	// * Run all actions
	async function refreshDataBase() {
		console.log('Clearing the db')

		await Promise.all([
			deleteCollection(db, '/movies', 10),
			deleteCollection(db, '/comingSoon', 5),
			deleteCollection(db, '/dates', 2)
		])

		console.log('Hacking the mainframe!')

		const showtimesHTML = await getHTML(
			'http://ellensburgmovies.com/gmc_html/gmc_html_showtimes.html'
		)

		const [dates, { movies, comingSoon }] = await Promise.all([
			getDates(showtimesHTML),
			getShowtimes(showtimesHTML)
		])

		console.log('Writing fresh data!')

		await Promise.all([addDates(dates), addMovies(movies), addComingSoon(comingSoon)])

		console.log('DB update successful!')
	}
	return refreshDataBase()
})

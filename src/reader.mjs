import {hasBuffer, isBrowser, isNode, isWorker, BufferView, DynamicBufferView} from './util/BufferView.mjs'
import {processOptions} from './options.mjs'
if (isNode) {
	if (typeof require === 'function')
		var fsPromise = Promise.resolve(require('fs').promises)
	else
		var fsPromise = import(/* webpackIgnore: true */ 'fs').then(module => module.promises)
}


function findTiff() {
	throw new Error('findTiff in reader is no longer legal')
}

// TODO: - minified UMD bundle
// TODO: - offer two UMD bundles (with tags.mjs dictionary and without)
// TODO: - API for including 3rd party XML parser
// TODO: - better code & file structure
// TODO: - JFIF: it usually only has 4 props with no practical use. but for completence
// TODO: - ICC profile

export default class Reader {

	constructor(options) {
		this.options = processOptions(options)
	}

	async read(arg) {
		if (typeof arg === 'string')
			await this.readString(arg)
		else if (isBrowser && !isWorker && arg instanceof HTMLImageElement)
			await this.readString(arg.src)
		else if (arg instanceof Uint8Array || arg instanceof ArrayBuffer || arg instanceof DataView)
			this.view = new BufferView(arg)
		else if (isBrowser && arg instanceof Blob)
			await this.readBlob(arg)
		else
			throw new Error('Invalid input argument')
	}

	async readString(string) {
		if (isBase64Url(string))
			await this.readBase64(string)
		else if (isBrowser)
			await this.readUrl(string)
		else if (isNode)
			await this.readFileFromDisk(string)
		else
			throw new Error('Invalid input argument')
	}

	async readBlob(blob) {
		this.view = new BlobReader(blob, this.options)
		await this.view.read(this.options.parseChunkSize)
	}

	async readUrl(url) {
		this.view = new UrlFetcher(url, this.options)
		await this.view.read(this.options.parseChunkSize)
	}

	async readBase64(base64) {
		this.view = new Base64Reader(base64, this.options)
		await this.view.read(this.options.seekChunkSize)
	}

	async readFileFromDisk(filePath) {
		this.view = new FsReader(filePath, this.options)
		await this.view.read()
	}

}



// This method came through three iterations. Tested with 4MB file with EXIF at the beginning.
// iteration #1 - Fetch whole file.
//              - Took about 23ms on average.
//              - It meant unnecessary conversion of whole 4MB
// iteration #2 - Fetch first 512 bytes, find exif, then fetch additional kilobytes of exif to be parsed.
//              - Exactly like what we do with Node's readFile() method.
//              - Slightly faster. 18ms on average.
//              - Certainly more efficient processing-wise. Only beginning of the file was read and converted.
//              - But the additional read of the exif chunk is expensive time-wise because browser's fetch and
//              - Blob<->ArrayBuffer manipulations are not as fast as Node's low-level fs.open() & fs.read().
// iteration #3 - This one we landed on.
//              - 11ms on average. (As fast as Node)
//              - Compromise between time and processing costs.
//              - Fetches first 64KB of the file. In most cases, EXIF isn't larger than that.
//              - In most cases, the 64KB is enough and we don't need additional fetch/convert operation.
//              - But we can do the second read if needed (edge cases) where the performance wouldn't be great anyway.
// It can be used with Blobs, URLs, Base64 (URL).
// blobs and fetching from url uses larger chunks with higher chances of having the whole exif within (iteration 3).
// base64 string (and base64 based url) uses smaller chunk at first (iteration 2).

// Accepts file path and uses lower-level FS APIs to open the file, read the first 512 bytes
// trying to locate EXIF and then reading only the portion of the file where EXIF is if found.
// If the EXIF is not found within the first 512 Bytes. the range can be adjusted by user,
// or it falls back to reading the whole file if enabled with options.allowWholeFile.

export class ChunkedReader extends DynamicBufferView {

	constructor(input, options) {
		super(0)
		this.input = input
		this.options = options
	}

	async readWhole() {
		this.chunked = false
		await this.readChunk(0)
	}

	async readChunked(size) {
		this.chunked = true
		await this.readChunk(0, size)
	}

	async read(size) {
		// Reading additional segments (XMP, ICC, IPTC) requires whole file to be loaded.
		// Chunked reading is only available for simple exif (APP1) FTD0
		if (this.forceWholeFile) return await this.readWhole()
		// Read Chunk
		await this.readChunked(size)
		// Seeking for the exif at the beginning of the file failed.
		// Fall back to scanning throughout the whole file if allowed.
		if (this.allowWholeFile) return await this.readWhole()
	}

	get allowWholeFile() {
		if (this.options.wholeFile === false) return false
		return this.options.wholeFile === true
			|| this.options.wholeFile === undefined
	}

	get forceWholeFile() {
		if (this.allowWholeFile === false) return false
		return this.options.wholeFile === true
			|| this.needWholeFile
	}

	get needWholeFile() {
		return !!this.options.xmp
			|| !!this.options.icc
			|| !!this.options.iptc
	}

	destroy() {}

}

export class FsReader extends ChunkedReader {

	bytesRead = 0

	async readWhole() {
		this.chunked = false
		let fs = await fsPromise
		let buffer = await fs.readFile(this.input)
		this._swapBuffer(buffer)
	}

	async readChunked() {
		this.chunked = true
		let fs = await fsPromise
		this.fh = await fs.open(this.input, 'r')
		await this.readChunk(0, this.options.seekChunkSize)
	}

	async readChunk(start, size) {
		var chunk = this.subarray(start, size, true)
		var {bytesRead} = await this.fh.read(chunk.dataView, 0, size, start)
		// read less data then requested. that means we're at the end and there's no more data to read.
		if (bytesRead < size) return this.destroy()
		return chunk
	}

	// TODO: auto close file handle when reading and parsing is over
	// (app can read more chunks after parsing the first)
	async destroy() {
		if (this.fh) {
			await this.fh.close().catch(console.error)
			this.fh = undefined
		}
	}

}

// TODO: make this optional. not everyone will ever use base64 inputs
export class Base64Reader extends ChunkedReader {

	// Accepts base64 or base64 URL and converts it to DataView and trims if needed.
	async readChunk(start, size) {
		let end = size ? start + size : undefined
		// Remove the mime type and base64 marker at the beginning so that we're left off with clear b64 string.
		let base64 = this.input.replace(/^data\:([^\;]+)\;base64,/gmi, '')
		if (hasBuffer) {
			// TODO: Investigate. this might not work if bundled Buffer is used in browser.
			// the slice/subarray shared memory viewed through DataView problem
			var arrayBuffer = Buffer
				.from(base64, 'base64')
				.slice(start, end)
				.buffer
		} else {
			var offset = 0
			// NOTE: Each 4 character block of base64 string represents 3 bytes of data.
			if (start !== undefined || end !== undefined) {
				if (start === undefined) {
					var blockStart = start = 0
				} else {
					var blockStart = Math.floor(start / 3) * 4
					offset = start - ((blockStart / 4) * 3)
				}
				if (end === undefined) {
					var blockEnd = base64.length
					end = (blockEnd / 4) * 3
				} else {
					var blockEnd = Math.ceil(end / 3) * 4
				}
				base64 = base64.slice(blockStart, blockEnd)
				var targetSize = end - start
			} else {
				var targetSize = (base64.length / 4) * 3
			}
			var binary = atob(base64)
			var arrayBuffer = new ArrayBuffer(targetSize)
			var uint8arr = new Uint8Array(arrayBuffer)
			for (var i = 0; i < targetSize; i++)
				uint8arr[i] = binary.charCodeAt(offset + i)
		}
		return new BufferView(arrayBuffer)
	}

}

export class UrlFetcher extends ChunkedReader {

	async readChunk(start, size) {
		let end = size ? start + size : undefined
		let url = this.input
		let headers = {}
		if (start || end) headers.range = `bytes=${[start, end].join('-')}`
		let res = await fetch(url, {headers})
		return new BufferView(await res.arrayBuffer())
	}

}

export class BlobReader extends ChunkedReader {

	readChunk(start, size) {
		let end = size ? start + size : undefined
		let blob = this.input.slice(start, end)
		return new Promise((resolve, reject) => {
			let reader = new FileReader()
			reader.onloadend = () => resolve(new BufferView(reader.result || new ArrayBuffer(0)))
			reader.onerror = reject
			reader.readAsArrayBuffer(blob)
		})
	}

}


// HELPER FUNCTIONS

function isBase64Url(string) {
	return string.startsWith('data:')
		|| string.length > 10000 // naive
	//	|| string.startsWith('/9j/') // expects JPG to always start the same
}


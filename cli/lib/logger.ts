import * as fs from "fs"
import * as path from "path"

const LOG_FILE = path.resolve(process.cwd(), "tracker.log")

// Clear log file on start
try {
	fs.writeFileSync(LOG_FILE, "")
} catch { }

export function logToFile(message: string) {
	const timestamp = new Date().toISOString()
	try {
		fs.appendFileSync(LOG_FILE, `[${timestamp}] ${message}\n`)
	} catch {
		// If logging fails, silently ignore to not break the app
	}
}

export function logErrorToFile(message: string, error?: any) {
	const timestamp = new Date().toISOString()
	let errDetail = ""
	if (error !== undefined) {
		if (error instanceof Error) {
			errDetail = ` - ${error.stack || error.message}`
		} else {
			errDetail = ` - ${String(error)}`
		}
	}
	try {
		fs.appendFileSync(LOG_FILE, `[${timestamp}] ERROR: ${message}${errDetail}\n`)
	} catch { }
}

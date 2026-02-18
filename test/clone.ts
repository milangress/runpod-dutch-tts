import { join } from "path"
import { runTest, writeOutput } from "./lib"

// Transcript of the audio prompt file (must match what's spoken in the audio)
const AUDIO_PROMPT_TRANSCRIPT =
	"[S1] Denk je dat je een open source model kan trainen met weinig geld en middelen? " +
	"[S2] Ja ik denk het wel. " +
	"[S1] Oh ja, hoe dan? " +
	"[S2] Nou kijk maar in de repo op Git Hub of Hugging Face."

const TEXTS = [
	"[S1] vandaag wil ik het hebben over kunstmatige intelligentie. het is een fascinerend onderwerp dat steeds meer invloed heeft op ons dagelijks leven. van slimme assistenten tot zelfrijdende auto's, de mogelijkheden zijn eindeloos. maar er zijn ook risico's waar we rekening mee moeten houden. laten we daar eens dieper op ingaan.",
	"[S1] het weer in Nederland is altijd een populair gespreksonderwerp. de ene dag schijnt de zon en is het prachtig buiten. de volgende dag regent het weer pijpenstelen en waait het hard. maar dat maakt ons niet uit, want we hebben altijd een paraplu bij de hand. dat is typisch Nederlands.",
	"[S1] ik ben gisteren naar het museum geweest in Amsterdam. de tentoonstelling over moderne kunst was echt indrukwekkend. er waren schilderijen van kunstenaars uit de hele wereld te zien. het mooiste vond ik een groot abstract werk in felle kleuren. ik raad iedereen aan om er een keer naartoe te gaan.",
	"[S1] koken is een van mijn favoriete hobby's. elke avond probeer ik iets nieuws te maken in de keuken. gisteren heb ik een heerlijke stamppot gemaakt met boerenkool en rookworst. het recept komt van mijn oma en het smaakt altijd fantastisch. de geur van verse kruiden maakt het helemaal af.",
]

const PARAMS = {
	max_new_tokens: 3072,
	guidance_scale: 3.0,
	temperature: 1,
	top_p: 0.95,
	top_k: 50,
	output_format: "wav",
	seed: 30,
}

runTest(async (client) => {
	const audioPromptFile = Bun.file(join(import.meta.dir, "audio-prompt.wav"))

	console.log(`🎤 Voice cloning batch test — ${TEXTS.length} texts`)
	console.log(`   Audio prompt: ${audioPromptFile.name}`)
	console.log(`   Transcript:   "${AUDIO_PROMPT_TRANSCRIPT}"`)

	const audioBytes = await audioPromptFile.arrayBuffer()
	const audioB64 = Buffer.from(audioBytes).toString("base64")

	console.log("\n🚀 Sending voice cloning request...")
	const result = await client.run({
		texts: TEXTS,
		audio_prompt: audioB64,
		audio_prompt_transcript: AUDIO_PROMPT_TRANSCRIPT,
		...PARAMS,
	})

	const audioBuffers = client.getAudio(result)
	console.log(`\n✅ Cloning complete — ${audioBuffers.length} audio buffers`)

	const format = result.output?.format || "wav"

	await Promise.all(audioBuffers.map(async (buffer, i) => {
		const filename = `clone_${i}.${format}`
		await writeOutput(`clone/${filename}`, buffer)
	}))

	console.log(`\n🎧 Files saved in output/clone/`)
})

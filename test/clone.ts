import { runTest, writeOutput } from "./lib"

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

runTest(async (client) => {
	const audioPrompt = await client.loadAudioPrompt("audio-prompt.wav")

	console.log(`🎤 Voice cloning — ${TEXTS.length} texts`)

	const results = await client.runAll(
		TEXTS.map((text, i) => ({
			text,
			label: `clone_${i}`,
			context: i,
			audioPrompt: audioPrompt.base64,
			audioPromptTranscript: AUDIO_PROMPT_TRANSCRIPT,
		})),
		{
			params: { max_new_tokens: 3072, guidance_scale: 3.0, temperature: 1, top_p: 0.95, top_k: 50, seed: 30 },
			onProgress: async (item) => {
				if (item.status === "completed" && item.audio) {
					await writeOutput(`clone/clone_${item.context}.${item.format}`, item.audio)
				}
			},
		}
	)

	client.printSummary(results, (item) => ({
		"#": item.context,
		Time: item.elapsed ? `${(item.elapsed / 1000).toFixed(1)}s` : "—",
		Size: item.audio ? `${(item.audio.length / 1024).toFixed(1)} KB` : "—",
	}))

	console.log(`\n🎧 Files saved in output/clone/`)
})

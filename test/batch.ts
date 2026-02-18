import { runTest, writeOutput } from "./lib"

const TEXTS = [
	"[S1] Ik ga volgende week op vakantie naar Italië. Ik heb er echt zin in, vooral in het lekkere eten en de mooie steden. Heb jij nog tips for leuke plekken?",
	"[S1] Gisteren heb ik een nieuw pasta recept geprobeerd. Het was verrassend lekker, met veel verse kruiden en geroosterde groenten. Ik zal het recept later met je delen.",
	"[S1] Heb je dat nieuwe boek al gelezen waar iedereen het over heeft? Ik ben er gisteren in begonnen en kon het bijna niet wegleggen. Het verhaal is zo spannend!",
	"[S1] Mijn computer is de laatste tijd zo traag. Ik denk dat het tijd wordt voor een nieuwe, of misschien moet ik hem gewoon even opschonen. Heb jij verstand van computers?",
	"[S1] De herfst is echt mijn favoriete seizoen. Ik hou van de kleuren van de bladeren en de frisse lucht tijdens een boswandeling. En natuurlijk warme chocolademelk drinken.",
	"[S1] Ben je wel eens naar een concert in de Ziggo Dome geweest? Het geluid is daar echt fantastisch. Ik ga er binnenkort weer heen voor mijn favoriete band.",
	"[S1] Ik probeer de laatste tijd wat vaker te gaan hardlopen. In het begin was het zwaar, maar nu begin ik het echt leuk te vinden. Het geeft me zoveel energie.",
	"[S1] Zullen we binnenkort weer eens afspreken met de hele groep? Het is alweer veel te lang geleden dat we elkaar allemaal gezien hebben. Misschien een etentje?",
	"[S1] Ik heb gisteren een hele goede film gezien op Netflix. Het was een thriller met een heel onverwacht plot. Ik zat echt op het puntje van mijn stoel.",
	"[S1] Nederlands leren is best lastig, vind je niet? Vooral de uitspraak en al die onregelmatige werkwoorden. Maar oefening baart kunst, zeggen ze.",
	"[S1] Ik heb nieuwe schoenen nodig voor de bruiloft van mijn zus. Ik heb al in drie winkels gekeken, maar ik kan niets vinden wat ik leuk vind. Misschien moet ik online kijken.",
	"[S1] We zijn bezig met het herinrichten van de woonkamer. We willen de muren een nieuwe kleur geven en een grotere bank kopen. Het wordt vast heel mooi.",
	"[S1] Wat zijn jouw plannen voor het weekend? Ik ga zaterdag naar de markt en zondag waarschijnlijk even rustig aan doen. Misschien ga ik nog even naar het strand als het weer goed is.",
]

const PARAMS = {
	max_new_tokens: 3072,
	guidance_scale: 3.0,
	temperature: 0,
	top_p: 0.8,
	top_k: 30,
	output_format: "wav",
	seed: 30,
}

runTest(async (client) => {
	console.log(`📦 Batch TTS — ${TEXTS.length} texts in one request`)
	TEXTS.forEach((t, i) => console.log(`   [${i}] "${t}"`))
	console.log()

	console.log("🚀 Sending batch request...")
	const result = await client.run({
		texts: TEXTS,
		...PARAMS,
	})

	const audioBuffers = client.getAudio(result)
	console.log(`\n✅ Batch complete — ${audioBuffers.length} audio buffers`)

	const format = result.output?.format || "wav"

	// Iterate using forEach
	await Promise.all(audioBuffers.map(async (buffer, i) => {
		const filename = `batch_${i}.${format}`
		await writeOutput(`batch/${filename}`, buffer)
	}))

	console.log(`\n🎧 Files saved in output/batch/`)
})

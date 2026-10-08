export class TelegramPanelIntent {
	private readonly generations = new Map<number, number>();

	begin(chatId: number): number {
		const generation = this.current(chatId) + 1;
		this.generations.set(chatId, generation);
		return generation;
	}

	current(chatId: number): number {
		return this.generations.get(chatId) ?? 0;
	}

	isCurrent(chatId: number, generation: number): boolean {
		return this.current(chatId) === generation;
	}
}

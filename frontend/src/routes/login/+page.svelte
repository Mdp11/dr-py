<script lang="ts">
	import { assets } from '$app/paths';
	import { fade } from 'svelte/transition';
	import { dur, PANEL } from '$lib/util/motion';
	import LoginForm from '$lib/components/auth/LoginForm.svelte';
</script>

<div class="flex min-h-screen flex-col items-center justify-center gap-10 bg-background px-6">
	<div in:fade={{ duration: dur(PANEL) }} class="flex flex-col items-center gap-10">
		<img
			src={`${assets}/dr-lockup.png`}
			alt="Data Rover — Model. Connect. Drive."
			class="w-80 max-w-full"
		/>
		<LoginForm />
	</div>
</div>

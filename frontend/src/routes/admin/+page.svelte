<script lang="ts">
	import * as Tabs from '$lib/components/ui/tabs';
	import UsersTab from '$lib/components/admin/UsersTab.svelte';
	import ProjectMembersTab from '$lib/components/admin/ProjectMembersTab.svelte';
</script>

<div class="mx-auto flex max-w-3xl flex-col gap-4 p-6">
	<h1 class="text-lg font-semibold text-zinc-100">Administration</h1>
	<Tabs.Root value="users">
		<Tabs.List>
			<Tabs.Trigger value="users">Users</Tabs.Trigger>
			<Tabs.Trigger value="members">Project members</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="users"><UsersTab /></Tabs.Content>
		<Tabs.Content value="members"><ProjectMembersTab /></Tabs.Content>
	</Tabs.Root>
</div>

// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	Button,
	Dialog,
	Empty,
	Input,
	Loader,
	Select,
	Text,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { EnvelopeIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { Link as RouterLink } from "react-router";
import api from "~/services/api";
import {
	useCreateMailbox,
	useDeleteMailbox,
	useMailboxes,
} from "~/queries/mailboxes";
import { queryKeys } from "~/queries/keys";

export function meta() {
	return [{ title: "Harizco Post" }];
}

export default function HomeRoute() {
	const toastManager = useKumoToastManager();
	const { data: mailboxes = [], isFetched: mailboxesFetched } = useMailboxes();
	const createMailbox = useCreateMailbox();
	const deleteMailbox = useDeleteMailbox();

	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: Infinity, // config rarely changes
	});

	const domains = configData?.domains ?? [];
	const emailAddresses = configData?.emailAddresses ?? [];
	const activeEmails = new Set(mailboxes.map((mailbox) => mailbox.email.toLowerCase()));
	const availableAddresses = emailAddresses.filter((address) => !activeEmails.has(address.toLowerCase()));

	const [isCreateOpen, setIsCreateOpen] = useState(false);
	const [newPrefix, setNewPrefix] = useState("");
	const [selectedAddress, setSelectedAddress] = useState("");
	const [selectedDomain, setSelectedDomain] = useState("");
	const [newName, setNewName] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [isDeleteOpen, setIsDeleteOpen] = useState(false);
	const [mailboxToDelete, setMailboxToDelete] = useState<{
		id: string;
		email: string;
	} | null>(null);
	const [isDeleting, setIsDeleting] = useState(false);

	// Set defaults from the addresses the operator has already configured.
	useEffect(() => {
		if (domains.length > 0 && !selectedDomain) setSelectedDomain(domains[0]);
		if (!availableAddresses.some((address) => address.toLowerCase() === selectedAddress.toLowerCase())) {
			setSelectedAddress(availableAddresses[0] ?? "");
		}
	}, [availableAddresses, domains, selectedAddress, selectedDomain]);

	const handleCreate = async (e: FormEvent) => {
		e.preventDefault();
		setCreateError(null);
		const email = isConfigured ? selectedAddress : `${newPrefix}@${selectedDomain}`;
		if (isConfigured ? !availableAddresses.includes(selectedAddress) : !newPrefix || !selectedDomain) {
			setCreateError(isConfigured ? "No additional pre-provisioned addresses are available." : "Please fill in all fields");
			return;
		}
		const localPart = email.split("@")[0] || email;
		const name = newName.trim() || localPart;
		setIsCreating(true);
		try {
			await createMailbox.mutateAsync({ email, name });
			toastManager.add({ title: isConfigured ? "Mailbox added" : "Mailbox created successfully!" });
			setIsCreateOpen(false);
			setNewPrefix("");
			setSelectedAddress("");
			setNewName("");
		} catch (err: unknown) {
			const message = (err instanceof Error ? err.message : null) || "Failed to create mailbox";
			setCreateError(message);
		} finally {
			setIsCreating(false);
		}
	};

	const handleDelete = async () => {
		if (!mailboxToDelete) return;
		setIsDeleting(true);
		try {
			await deleteMailbox.mutateAsync(mailboxToDelete.id);
			toastManager.add({ title: "Mailbox deleted" });
			setIsDeleteOpen(false);
			setMailboxToDelete(null);
		} catch {
			toastManager.add({ title: "Failed to delete mailbox", variant: "error" });
		} finally {
			setIsDeleting(false);
		}
	};

	const isConfigured = emailAddresses.length > 0;
	const accounts = mailboxes;

	const isLoading = !configData || !mailboxesFetched;

	return (
		<div className="min-h-screen bg-kumo-recessed">
			<div className="mx-auto max-w-2xl px-4 py-8 md:px-6 md:py-16">
				<div className="mb-8">
					<div className="flex items-center justify-between">
						<h1 className="text-2xl font-bold text-kumo-default">Mailboxes</h1>
						{domains.length > 0 && (
							<Button
								variant="primary"
								icon={<PlusIcon size={16} />}
								onClick={() => {
									setCreateError(null);
									setIsCreateOpen(true);
								}}
							>
								Add mailbox
							</Button>
						)}
					</div>
					{domains.length > 0 && (
						<p className="text-sm text-kumo-subtle mt-1">
							{domains.join(", ")}
						</p>
					)}
				</div>

				{isLoading ? (
					<div className="flex justify-center py-20">
						<Loader size="lg" />
					</div>
				) : accounts.length > 0 ? (
					<div className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
						{accounts.map((account, idx) => (
							<RouterLink
								key={account.id}
								to={`/mailbox/${account.id}`}
								className={`group flex items-center gap-4 px-5 py-4 no-underline transition-colors hover:bg-kumo-tint ${
									idx > 0 ? "border-t border-kumo-line" : ""
								}`}
							>
								<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-kumo-fill text-sm font-bold text-kumo-default">
									{account.name.charAt(0).toUpperCase()}
								</div>
								<div className="min-w-0 flex-1">
									<div className="text-sm font-medium text-kumo-default truncate">
										{account.name}
									</div>
									<div className="text-sm text-kumo-subtle">
										{account.email}
									</div>
								</div>
								{!isConfigured && (
									<Button
										variant="ghost"
										size="sm"
										shape="square"
										icon={<TrashIcon size={16} />}
										aria-label={`Delete mailbox ${account.email}`}
										onClick={(e) => {
											e.preventDefault();
											e.stopPropagation();
											setMailboxToDelete({
												id: account.id,
												email: account.email,
											});
											setIsDeleteOpen(true);
										}}
									/>
								)}
							</RouterLink>
						))}
					</div>
				) : (
					<div className="rounded-xl border border-kumo-line bg-kumo-base py-16 px-6">
						<div className="flex flex-col items-center text-center">
							<div className="mb-4">
								<EnvelopeIcon
									size={48}
									weight="thin"
									className="text-kumo-subtle"
								/>
							</div>
							<h3 className="text-base font-semibold text-kumo-default mb-1.5">
								No mailboxes yet
							</h3>
							<p className="text-sm text-kumo-subtle max-w-sm mb-5">
								{isConfigured
									? "No mailbox is linked yet. Use Add mailbox to link an operator-provisioned address."
									: "Create a mailbox to start sending and receiving emails with your domain."}
							</p>
							{domains.length > 0 && (
								<Button
									variant="primary"
									icon={<PlusIcon size={16} />}
									onClick={() => {
										setCreateError(null);
										setIsCreateOpen(true);
									}}
								>
									Add mailbox
								</Button>
							)}
						</div>
					</div>
				)}
			</div>

			{/* Create Dialog */}
			<Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-5">
						{isConfigured ? "Add Mailbox" : "Create New Mailbox"}
					</Dialog.Title>
					<form onSubmit={handleCreate} className="space-y-4">
						{createError && (
							<Text variant="error" size="sm">
								{createError}
							</Text>
						)}
						{isConfigured ? (
							<div>
								<span className="text-sm font-medium text-kumo-default mb-1.5 block">Mailbox address</span>
								{availableAddresses.length > 0 ? (
									<>
										<Select
										aria-label="Pre-provisioned address"
										value={selectedAddress}
										onValueChange={(value) => { if (value) setSelectedAddress(value); }}
									>
										{availableAddresses.map((address) => (
											<Select.Option key={address} value={address}>{address}</Select.Option>
										))}
									</Select>
									<p className="mt-2 text-xs text-kumo-subtle">This links an existing Stalwart mailbox; it does not create a server account.</p>
									</>
								) : (
									<div className="rounded-md bg-kumo-fill px-3 py-2 text-sm text-kumo-subtle">
										<p>No additional configured addresses are available.</p>
										<p className="mt-1">An operator must configure the address and its separate Stalwart account first.</p>
									</div>
								)}
							</div>
						) : (
							<div>
								<span className="text-sm font-medium text-kumo-default mb-1.5 block">Email Address</span>
								<div className="flex items-center gap-2">
									<div className="flex-1">
										<Input
											aria-label="Address prefix"
											placeholder="info"
											size="sm"
											value={newPrefix}
											onChange={(e) => setNewPrefix(e.target.value)}
											required
										/>
									</div>
									<span className="text-sm text-kumo-subtle">@</span>
									{domains.length > 1 ? (
										<div className="flex-1">
											<Select
											aria-label="Domain"
											value={selectedDomain}
											onValueChange={(value) => { if (value) setSelectedDomain(value); }}
										>
											{domains.map((domain) => (
												<Select.Option key={domain} value={domain}>{domain}</Select.Option>
											))}
										</Select>
										</div>
									) : (
										<span className="text-sm text-kumo-subtle">{selectedDomain || "no domain"}</span>
									)}
								</div>
							</div>
						)}
						<Input
							label="Display Name (optional)"
							placeholder="Info"
							size="sm"
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
						/>
						<div className="flex justify-end gap-2 pt-2">
							<Dialog.Close
								render={(props) => (
									<Button {...props} variant="secondary" size="sm">
										Cancel
									</Button>
								)}
							/>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isCreating}
								disabled={isConfigured ? !availableAddresses.includes(selectedAddress) : !newPrefix || !selectedDomain}
							>
								{isConfigured ? "Add" : "Create"}
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>

			{/* Delete Dialog */}
			<Dialog.Root
				open={isDeleteOpen}
				onOpenChange={(open) => {
					setIsDeleteOpen(open);
					if (!open) setMailboxToDelete(null);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-2">
						Delete Mailbox
					</Dialog.Title>
					<Dialog.Description className="text-kumo-subtle text-sm mb-5">
						Are you sure you want to delete{" "}
						<strong className="text-kumo-default">
							{mailboxToDelete?.email}
						</strong>
						? This action cannot be undone.
					</Dialog.Description>
					<div className="flex justify-end gap-2">
						<Dialog.Close
							render={(props) => (
								<Button {...props} variant="secondary" size="sm">
									Cancel
								</Button>
							)}
						/>
						<Button
							variant="destructive"
							size="sm"
							loading={isDeleting}
							onClick={handleDelete}
						>
							Delete
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}

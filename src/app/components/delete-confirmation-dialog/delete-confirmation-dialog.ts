import { Component, ElementRef, effect, input, output, viewChild } from '@angular/core';

export interface DeleteConfirmationTarget {
  id: string;
  name: string;
  scope: 'ups' | 'source';
  deviceCount: number;
}

@Component({
  selector: 'app-delete-confirmation-dialog',
  styleUrl: './delete-confirmation-dialog.css',
  templateUrl: './delete-confirmation-dialog.html',
})
export class DeleteConfirmationDialog {
  readonly open = input(false);
  readonly busy = input(false);
  readonly error = input('');
  readonly target = input<DeleteConfirmationTarget | null>(null);
  readonly confirmed = output<void>();
  readonly cancelled = output<void>();
  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  private readonly syncOpenState = effect(() => {
    const dialog = this.dialog()?.nativeElement;
    if (!dialog) return;
    if (this.open() && !dialog.open) dialog.showModal();
    else if (!this.open() && dialog.open) dialog.close();
  });

  handleCancel(event: Event): void {
    event.preventDefault();
    if (!this.busy()) this.cancelled.emit();
  }

  handleDialogClick(event: MouseEvent): void {
    if (event.target === event.currentTarget && !this.busy()) this.cancelled.emit();
  }
}
